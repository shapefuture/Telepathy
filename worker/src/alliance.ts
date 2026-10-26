// Союз and Мост (plan: journeys 5 and 6). Two clubs on this bot agree to exchange requests.
// Only the text of a request crosses. Names, member lists and contacts never do; a contact opens
// only when the helper and the asker both agree. Each side decides how far it goes, and either
// side can pause or end the alliance with one tap.

import { readable, type Member } from "./acl";
import { matchSkills } from "./experts";
import { defaultLang, T, type Lang, type Messages } from "./i18n";
import { effectStatement } from "./outbox";
import { bridgeCardKeys, btn } from "./thread-card";
import type { InlineButton } from "./telegram";
import { escapeHtml } from "./text";
import { addMs, DAY, newId, nowIso } from "./util";
import { topTopics } from "./wow";

export const LEVELS = ["requests", "experts", "full"] as const;
export type Level = (typeof LEVELS)[number];
const RANK: Record<Level, number> = { requests: 1, experts: 2, full: 3 };
export const lowerLevel = (a: Level, b: Level): Level => (RANK[a] <= RANK[b] ? a : b);
export const isLevel = (v: string): v is Level => (LEVELS as readonly string[]).includes(v);
export const INVITE_TTL = 7 * DAY;
export const BRIDGE_TTL = 7 * DAY;
/** How many experts a bridged request is offered to (plan: "experts see requests as roles"). */
export const BRIDGE_EXPERTS = 2;

export const levelWord = (m: Messages, l: Level) => (l === "requests" ? m.levelRequests : l === "experts" ? m.levelExperts : m.levelFull);
export const levelWhat = (m: Messages, l: Level) => (l === "requests" ? m.levelRequestsWhat : l === "experts" ? m.levelExpertsWhat : m.levelFullWhat);

/** The clubs a member manages: the groups they connected, newest first. */
export async function clubsOf(db: D1Database, memberId: string): Promise<{ id: string; title: string | null; chat_id: number }[]> {
  return (
    await db.prepare("SELECT id, title, chat_id FROM sources WHERE enabled=1 AND enabled_by=? ORDER BY enabled_at DESC").bind(memberId).all<{ id: string; title: string | null; chat_id: number }>()
  ).results;
}

/** An invitation a club owner can send to another club owner. One use, seven days. */
export async function createInvite(db: D1Database, sourceId: string, memberId: string, level: Level, now = nowIso()): Promise<string> {
  const code = newId().slice(0, 16);
  await db
    .prepare("INSERT INTO alliance_invites(code, inviter_source_id, inviter_member_id, level, created_at, expires_at) VALUES (?,?,?,?,?,?)")
    .bind(code, sourceId, memberId, level, now, addMs(now, INVITE_TTL))
    .run();
  return code;
}

/** What the invited owner sees before they accept: who is asking, how big, what they talk about. */
export async function inviteCard(db: D1Database, code: string, lang: Lang, now = nowIso()): Promise<{ text: string; buttons: InlineButton[][] } | null> {
  const inv = await db
    .prepare("SELECT i.level, s.id AS source_id, s.title FROM alliance_invites i JOIN sources s ON s.id = i.inviter_source_id WHERE i.code=? AND i.used_at IS NULL AND i.expires_at > ?")
    .bind(code, now)
    .first<{ level: Level; source_id: string; title: string | null }>();
  if (!inv) return null;
  const m = T(lang);
  const members = (await db.prepare("SELECT COUNT(DISTINCT member_id) AS n FROM source_access WHERE source_id=? AND revoked_at IS NULL").bind(inv.source_id).first<{ n: number }>())?.n ?? 0;
  const topics = await topTopics(db, inv.source_id, lang, 4);
  const title = escapeHtml(inv.title ?? "");
  const lines = [m.unionCardTitle(title, members)];
  if (topics.length) lines.push(m.unionCardTopics(topics.map((t) => escapeHtml(t)).join(" · ")));
  lines.push("", `<b>${m.unionWhatCrosses}</b>`);
  for (const l of LEVELS) lines.push(`${levelWord(m, l)} — ${levelWhat(m, l)}`);
  return { text: lines.join("\n"), buttons: LEVELS.map((l) => [btn(levelWord(m, l), `ac:${code}:${l}`)]) };
}

/**
 * Accept an invitation with the club this owner manages most recently. The alliance runs at the
 * smaller of the two levels. The inviter is told; both sides can see it in /union.
 */
export async function acceptInvite(db: D1Database, code: string, memberId: string, offered: Level, now = nowIso()): Promise<{ ok: boolean; reason?: string; text?: string; keys: string[] }> {
  const m = T(await langOf(db, memberId));
  const inv = await db.prepare("SELECT * FROM alliance_invites WHERE code=?").bind(code).first<{ inviter_source_id: string; inviter_member_id: string; level: Level; used_at: string | null; expires_at: string }>();
  if (!inv || inv.used_at || inv.expires_at <= now) return { ok: false, reason: "gone", text: m.unionGone, keys: [] };
  const club = (await clubsOf(db, memberId))[0];
  if (!club) return { ok: false, reason: "no_club", text: m.unionNoClub, keys: [] };
  if (club.id === inv.inviter_source_id) return { ok: false, reason: "same", text: m.unionSame, keys: [] };
  const exists = await db
    .prepare("SELECT 1 FROM alliances WHERE (inviter_source_id=? AND partner_source_id=?) OR (inviter_source_id=? AND partner_source_id=?)")
    .bind(inv.inviter_source_id, club.id, club.id, inv.inviter_source_id)
    .first();
  if (exists) return { ok: false, reason: "exists", text: m.unionExists, keys: [] };
  const level = lowerLevel(inv.level, offered);
  const id = newId();
  const claim = await db.prepare("UPDATE alliance_invites SET used_at=? WHERE code=? AND used_at IS NULL").bind(now, code).run();
  if (!claim.meta.changes) return { ok: false, reason: "gone", text: m.unionGone, keys: [] };
  const inviter = await db.prepare("SELECT title FROM sources WHERE id=?").bind(inv.inviter_source_id).first<{ title: string | null }>();
  const inviterOwner = await db.prepare("SELECT m.tg_id, m.lang FROM members m WHERE m.id=?").bind(inv.inviter_member_id).first<{ tg_id: number; lang: Lang | null }>();
  await db.prepare("INSERT INTO alliances(id, inviter_source_id, partner_source_id, level, status, created_at, updated_at) VALUES (?,?,?,?, 'active', ?, ?)")
    .bind(id, inv.inviter_source_id, club.id, level, now, now)
    .run();
  const keys: string[] = [];
  if (inviterOwner) {
    const key = `union:${id}:accepted`;
    const om = T(inviterOwner.lang ?? defaultLang());
    await effectStatement(db, key, inviterOwner.tg_id, { text: om.unionAccepted(escapeHtml(club.title ?? ""), levelWord(om, level)) }).run();
    keys.push(key);
  }
  return { ok: true, keys, text: m.unionJoined(escapeHtml(inviter?.title ?? ""), levelWord(m, level)) };
}

async function langOf(db: D1Database, memberId: string): Promise<Lang> {
  return ((await db.prepare("SELECT lang FROM members WHERE id=?").bind(memberId).first<{ lang: Lang | null }>())?.lang) ?? defaultLang();
}

/** Every alliance one of this member's clubs is part of, with the two-sided credit (plan: journey 6). */
export async function alliancesOf(db: D1Database, memberId: string): Promise<{ id: string; mine: string; other: string; level: Level; status: string; helped: number; received: number }[]> {
  const rows = (
    await db
      .prepare(
        "SELECT a.id, a.level, a.status, a.inviter_source_id AS inv, a.partner_source_id AS par, si.title AS inv_title, sp.title AS par_title " +
          "FROM alliances a JOIN sources si ON si.id = a.inviter_source_id JOIN sources sp ON sp.id = a.partner_source_id " +
          "WHERE a.inviter_source_id IN (SELECT id FROM sources WHERE enabled_by=?) OR a.partner_source_id IN (SELECT id FROM sources WHERE enabled_by=?) ORDER BY a.created_at",
      )
      .bind(memberId, memberId)
      .all<{ id: string; level: Level; status: string; inv: string; par: string; inv_title: string | null; par_title: string | null }>()
  ).results;
  const out = [];
  for (const r of rows) {
    const mineIsInviter = (await db.prepare("SELECT 1 FROM sources WHERE id=? AND enabled_by=?").bind(r.inv, memberId).first()) !== null;
    const mine = mineIsInviter ? r.inv : r.par;
    const credit = await db
      .prepare("SELECT SUM(CASE WHEN to_source_id=? AND outcome='helpful' THEN 1 ELSE 0 END) AS helped, SUM(CASE WHEN from_source_id=? AND outcome='helpful' THEN 1 ELSE 0 END) AS received FROM bridges WHERE alliance_id=?")
      .bind(mine, mine, r.id)
      .first<{ helped: number | null; received: number | null }>();
    out.push({
      id: r.id,
      mine: mineIsInviter ? (r.inv_title ?? "") : (r.par_title ?? ""),
      other: mineIsInviter ? (r.par_title ?? "") : (r.inv_title ?? ""),
      level: r.level,
      status: r.status,
      helped: credit?.helped ?? 0,
      received: credit?.received ?? 0,
    });
  }
  return out;
}

/** Pause, resume or end an alliance. Only a club on either side may, and the other side is told. */
export async function setAlliance(db: D1Database, memberId: string, allianceId: string, action: "pause" | "resume" | "end", now = nowIso()): Promise<{ ok: boolean; keys: string[] }> {
  const a = await db.prepare("SELECT * FROM alliances WHERE id=?").bind(allianceId).first<{ inviter_source_id: string; partner_source_id: string; status: string }>();
  if (!a) return { ok: false, keys: [] };
  const managed = new Set((await clubsOf(db, memberId)).map((c) => c.id));
  if (!managed.has(a.inviter_source_id) && !managed.has(a.partner_source_id)) return { ok: false, keys: [] };
  const to = action === "pause" ? "paused" : action === "resume" ? "active" : "ended";
  const allowed = action === "resume" ? a.status === "paused" : a.status !== "ended";
  if (!allowed || a.status === to) return { ok: false, keys: [] };
  await db.prepare("UPDATE alliances SET status=?, updated_at=? WHERE id=?").bind(to, now, allianceId).run();
  const keys: string[] = [];
  for (const sid of [a.inviter_source_id, a.partner_source_id]) {
    const owner = await db.prepare("SELECT m.tg_id, m.lang, s.title FROM sources s JOIN members m ON m.id=s.enabled_by WHERE s.id=?").bind(sid).first<{ tg_id: number; lang: Lang | null; title: string | null }>();
    if (!owner) continue;
    const key = `union:${allianceId}:${to}:${sid}`;
    const om = T(owner.lang ?? defaultLang());
    await effectStatement(db, key, owner.tg_id, { text: om.unionNotice(to) }).run();
    keys.push(key);
  }
  return { ok: true, keys };
}

// ---- Мост -------------------------------------------------------------------------------

/** Experts of the partner club who can take a request: discoverable, skilled, and in that club. */
export async function bridgeExperts(db: D1Database, toSourceId: string, question: string, now = nowIso()): Promise<{ id: string; tg_id: number; lang: Lang | null }[]> {
  const codes = matchSkills(question, 3);
  if (!codes.length) return [];
  const h = new Date(now).getUTCHours();
  return (
    await db
      .prepare(
        "SELECT m.id, m.tg_id, m.lang, COUNT(DISTINCT s.code) AS matched FROM members m " +
          "JOIN skills s ON s.member_id = m.id AND s.state = 'confirmed' AND s.code IN (SELECT value FROM json_each(?)) " +
          "WHERE m.discoverable = 1 AND m.available = 1 AND m.removed_at IS NULL AND m.collection_opt_out = 0 " +
          "AND EXISTS (SELECT 1 FROM source_access a WHERE a.member_id = m.id AND a.source_id = ? AND a.revoked_at IS NULL) " +
          "AND NOT (m.quiet_from IS NOT NULL AND ((m.quiet_from <= m.quiet_to AND ? >= m.quiet_from AND ? < m.quiet_to) OR (m.quiet_from > m.quiet_to AND (? >= m.quiet_from OR ? < m.quiet_to)))) " +
          "GROUP BY m.id ORDER BY matched DESC, m.id LIMIT ?",
      )
      .bind(JSON.stringify(codes), toSourceId, h, h, h, h, BRIDGE_EXPERTS)
      .all<{ id: string; tg_id: number; lang: Lang | null }>()
  ).results;
}

/** The request as the partner club sees it: its text and the club it came from. Nothing about the asker. */
export async function deliverBridge(db: D1Database, bridgeId: string, now = nowIso()): Promise<string[]> {
  const b = await db.prepare("SELECT b.*, a.level FROM bridges b JOIN alliances a ON a.id = b.alliance_id WHERE b.id=?").bind(bridgeId).first<{ from_source_id: string; to_source_id: string; question: string; level: Level; status: string }>();
  if (!b || b.status !== "open") return [];
  const from = (await db.prepare("SELECT title FROM sources WHERE id=?").bind(b.from_source_id).first<{ title: string | null }>())?.title ?? "";
  const owner = await db
    .prepare("SELECT m.id, m.tg_id, m.lang FROM sources s JOIN members m ON m.id = s.enabled_by WHERE s.id=?")
    .bind(b.to_source_id)
    .first<{ id: string; tg_id: number; lang: Lang | null }>();
  const recipients: { id: string; tg_id: number; lang: Lang | null }[] = [];
  if (owner) recipients.push(owner);
  if (RANK[b.level] >= RANK.experts) for (const e of await bridgeExperts(db, b.to_source_id, b.question, now)) if (!recipients.some((r) => r.id === e.id)) recipients.push(e);
  const keys: string[] = [];
  for (const r of recipients) {
    // Keyed per attempt, so the operator can send it again later without the ledger dropping it.
    const key = `bridge:${bridgeId}:${r.id}:${newId()}`;
    const m = T(r.lang ?? defaultLang());
    const text = m.bridgeAsk(escapeHtml(from), escapeHtml(b.question.slice(0, 500)));
    await effectStatement(db, key, r.tg_id, { text, buttons: [[btn(m.bHelpIt, `bh:${bridgeId}:yes`)], [btn(m.bDecline, `bh:${bridgeId}:no`)]] }).run();
    keys.push(key);
  }
  return keys;
}

/**
 * The asker's "Спросить в клубах-партнёрах". Picks an active alliance the asker can read from
 * (the club they asked in first), records the bridge, and delivers the request text to the partner.
 */
export async function bridgeFromThread(db: D1Database, mem: Member, threadId: string, question: string, sourceId: string | null, now = nowIso()): Promise<{ ok: boolean; bridgeId?: string; keys: string[]; text?: string }> {
  const m = T(mem.lang ?? defaultLang());
  const mine = await readable(db, mem);
  const rows = (
    await db
      .prepare("SELECT id, inviter_source_id AS inv, partner_source_id AS par FROM alliances WHERE status='active' AND (inviter_source_id IN (SELECT value FROM json_each(?)) OR partner_source_id IN (SELECT value FROM json_each(?)))")
      .bind(JSON.stringify([...mine]), JSON.stringify([...mine]))
      .all<{ id: string; inv: string; par: string }>()
  ).results;
  const pick = rows.find((r) => r.inv === sourceId || r.par === sourceId) ?? rows[0];
  if (!pick) return { ok: false, keys: [], text: m.bridgeNone };
  const from = mine.has(pick.inv) ? pick.inv : pick.par;
  const to = from === pick.inv ? pick.par : pick.inv;
  const bridgeId = newId();
  await db
    .prepare("INSERT INTO bridges(id, alliance_id, from_source_id, to_source_id, asker_id, question, status, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?, 'open', ?, ?, ?)")
    .bind(bridgeId, pick.id, from, to, mem.id, question.slice(0, 500), now, now, addMs(now, BRIDGE_TTL))
    .run();
  await db.prepare("UPDATE threads SET bridge_id=?, updated_at=? WHERE id=?").bind(bridgeId, now, threadId).run();
  const keys = await deliverBridge(db, bridgeId, now);
  return { ok: true, bridgeId, keys };
}

/** A partner-side press: "Помогу" (yes) or "Не сейчас" (no). Contacts open only on both sides' yes. */
export async function answerBridgeAsHelper(db: D1Database, helper: Member, bridgeId: string, now = nowIso()): Promise<{ ok: boolean; text: string; keys: string[] }> {
  const b = await db.prepare("SELECT * FROM bridges WHERE id=?").bind(bridgeId).first<{ from_source_id: string; to_source_id: string; asker_id: string; status: string; helper_id: string | null }>();
  const m = T(helper.lang ?? defaultLang());
  if (!b || b.status !== "open") return { ok: false, text: m.bridgeGone, keys: [] };
  const access = await db.prepare("SELECT 1 FROM source_access WHERE source_id=? AND member_id=? AND revoked_at IS NULL").bind(b.to_source_id, helper.id).first();
  if (!access) return { ok: false, text: m.notAvailable, keys: [] };
  const won = await db.prepare("UPDATE bridges SET status='helper_yes', helper_id=?, updated_at=? WHERE id=? AND status='open'").bind(helper.id, now, bridgeId).run();
  if (!won.meta.changes) return { ok: false, text: m.bridgeTaken, keys: [] };
  const to = (await db.prepare("SELECT title FROM sources WHERE id=?").bind(b.to_source_id).first<{ title: string | null }>())?.title ?? "";
  const asker = await db.prepare("SELECT tg_id, lang FROM members WHERE id=?").bind(b.asker_id).first<{ tg_id: number; lang: Lang | null }>();
  const keys: string[] = [];
  if (asker) {
    const key = `bridge:${bridgeId}:helped`;
    const am = T(asker.lang ?? defaultLang());
    await effectStatement(db, key, asker.tg_id, { text: am.bridgeHelp(escapeHtml(to)), buttons: [[btn(am.bOpenContact, `bh:${bridgeId}:ask`)]] }).run();
    keys.push(key);
  }
  return { ok: true, text: m.bridgeThanksHelper, keys: [...keys, ...(await bridgeCardKeys(db, bridgeId, now))] };
}

/** The asker agrees to connect. Both have said yes now, so the contacts go to both. */
export async function connectBridge(db: D1Database, asker: Member, bridgeId: string, now = nowIso()): Promise<{ ok: boolean; text: string; keys: string[] }> {
  const m = T(asker.lang ?? defaultLang());
  const b = await db.prepare("SELECT * FROM bridges WHERE id=? AND asker_id=?").bind(bridgeId, asker.id).first<{ to_source_id: string; status: string; helper_id: string | null }>();
  if (!b || b.status !== "helper_yes" || !b.helper_id) return { ok: false, text: m.bridgeGone, keys: [] };
  const won = await db.prepare("UPDATE bridges SET status='connected', updated_at=? WHERE id=? AND status='helper_yes'").bind(now, bridgeId).run();
  if (!won.meta.changes) return { ok: false, text: m.bridgeGone, keys: [] };
  const helper = await db.prepare("SELECT tg_id, lang FROM members WHERE id=?").bind(b.helper_id).first<{ tg_id: number; lang: Lang | null }>();
  const to = (await db.prepare("SELECT title FROM sources WHERE id=?").bind(b.to_source_id).first<{ title: string | null }>())?.title ?? "";
  const keys: string[] = [];
  if (helper) {
    const hm = T(helper.lang ?? defaultLang());
    const key = `bridge:${bridgeId}:connected:helper`;
    await effectStatement(db, key, helper.tg_id, { text: hm.bridgeConnectedHelper, reveal_tg_id: asker.tg_id }).run();
    keys.push(key);
  }
  const key = `bridge:${bridgeId}:connected:asker`;
  await effectStatement(db, key, asker.tg_id, { text: m.bridgeConnected(escapeHtml(to)), reveal_tg_id: helper?.tg_id }).run();
  keys.push(key);
  return { ok: true, text: m.bridgeConnected(escapeHtml(to)), keys: [...keys, ...(await bridgeCardKeys(db, bridgeId, now))] };
}

/** "Помогло" after a bridged connection: credit to the helping club, and the request closes. */
export async function closeBridgeHelpful(db: D1Database, asker: Member, bridgeId: string, now = nowIso()): Promise<boolean> {
  const r = await db.prepare("UPDATE bridges SET status='closed', outcome='helpful', updated_at=? WHERE id=? AND asker_id=? AND status='connected'").bind(now, bridgeId, asker.id).run();
  return r.meta.changes > 0;
}

/** Cron: a bridge nobody answered within a week expires, and the asker's card says so. */
export async function expireBridges(db: D1Database, now = nowIso()): Promise<string[]> {
  const { results } = await db.prepare("SELECT id FROM bridges WHERE status='open' AND expires_at <= ? LIMIT 50").bind(now).all<{ id: string }>();
  const keys: string[] = [];
  for (const r of results) {
    const done = await db.prepare("UPDATE bridges SET status='expired', updated_at=? WHERE id=? AND status='open'").bind(now, r.id).run();
    if (done.meta.changes) keys.push(...(await bridgeCardKeys(db, r.id, now)));
  }
  return keys;
}

/** Operator's pilot console: every bridge, with what happened to it (recorded, including failures). */
export async function bridgeBoard(db: D1Database, lang: Lang, limit = 12): Promise<{ id: string; line: string; open: boolean }[]> {
  const rows = (
    await db
      .prepare(
        "SELECT b.id, b.status, b.created_at, fs.title AS f, ts.title AS t FROM bridges b JOIN sources fs ON fs.id = b.from_source_id JOIN sources ts ON ts.id = b.to_source_id ORDER BY b.created_at DESC LIMIT ?",
      )
      .bind(limit)
      .all<{ id: string; status: string; created_at: string; f: string | null; t: string | null }>()
  ).results;
  const m = T(lang);
  const status: Record<string, string> = { open: m.bridgeStatusOpen, helper_yes: m.bridgeStatusHelper, connected: m.bridgeStatusConnected, closed: m.bridgeStatusClosed, expired: m.bridgeStatusExpired };
  return rows.map((r) => ({
    id: r.id,
    open: r.status === "open" || r.status === "helper_yes",
    line: `<code>${r.id.slice(0, 8)}</code> · ${escapeHtml(r.f ?? "")} → ${escapeHtml(r.t ?? "")} · ${status[r.status] ?? r.status} · ${r.created_at.slice(0, 10)}`,
  }));
}
