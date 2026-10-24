// Consent-based introductions (P09, C05).
// /intro text -> need -> best eligible expert gets an anonymous invite -> expert accepts ->
// requester confirms -> only then both receive each other's contact. Decline or expiry moves
// on to the next candidate (max 3). Every send goes through the effect ledger.

import { defaultLang } from "./i18n";
import { eligibleCandidates, labelsFor, matchSkills } from "./experts";
import { T, type Lang } from "./i18n";
import { effectStatement } from "./outbox";
import { escapeHtml } from "./text";
import { DAY, HOUR, addMs, audit, newId, nowIso } from "./util";

export type Status = "invited" | "accepted" | "mutually_confirmed" | "completed" | "declined" | "expired" | "cancelled";
export type Event = "accept" | "decline" | "confirm" | "complete" | "expire" | "cancel";
export type Actor = "requester" | "candidate" | "system";

export const TERMINAL: ReadonlySet<Status> = new Set(["completed", "declined", "expired", "cancelled"]);
export const REVEAL: ReadonlySet<Status> = new Set(["mutually_confirmed", "completed"]);
export const INVITE_TTL = 72 * HOUR;
export const REQUEST_TTL = 14 * DAY;
export const REMINDER_AFTER = 24 * HOUR;
export const REQUESTER_WEEKLY_CAP = 2;
export const MAX_CANDIDATES = 3;

const BOTH: Actor[] = ["requester", "candidate"];
export const TRANSITIONS: Record<string, { to: Status; actors: Actor[] }> = {
  "invited:accept": { to: "accepted", actors: ["candidate"] },
  "invited:decline": { to: "declined", actors: ["candidate"] },
  "invited:expire": { to: "expired", actors: ["system"] },
  "invited:cancel": { to: "cancelled", actors: BOTH },
  "accepted:confirm": { to: "mutually_confirmed", actors: ["requester"] },
  "accepted:expire": { to: "expired", actors: ["system"] },
  "accepted:cancel": { to: "cancelled", actors: BOTH },
  "mutually_confirmed:complete": { to: "completed", actors: BOTH },
  "mutually_confirmed:cancel": { to: "cancelled", actors: BOTH },
};

/** Pure transition check. Returns the next status or null if not allowed. */
export function next(status: Status, event: Event, actor: Actor): Status | null {
  const t = TRANSITIONS[`${status}:${event}`];
  return t && t.actors.includes(actor) ? t.to : null;
}

export class IntroError extends Error {} // user-facing, safe to show

interface IntroRow {
  id: string;
  need_id: string;
  requester_id: string;
  candidate_id: string;
  status: Status;
  created_at: string;
  invite_expires_at: string;
}

/** Telegram id and interface language of a member, so each person gets messages in their language. */
async function contact(db: D1Database, memberId: string): Promise<{ tg: number; lang: Lang }> {
  const r = await db.prepare("SELECT tg_id, lang FROM members WHERE id=?").bind(memberId).first<{ tg_id: number; lang: Lang | null }>();
  if (!r) throw new IntroError("member not found");
  return { tg: r.tg_id, lang: r.lang ?? defaultLang() };
}

const btn = (text: string, data: string) => ({ text, callback_data: data });

export async function requestIntro(
  db: D1Database,
  requesterId: string,
  rawText: string,
  now = nowIso(),
  lang: Lang = "en",
): Promise<{ needId: string; introId: string | null; skills: string[]; keys: string[] }> {
  const text = rawText.split(/\s+/).join(" ").trim().slice(0, 500);
  const skills = matchSkills(text);
  if (!skills.length) {
    throw new IntroError(T(lang).introNoSkill);
  }
  const open = await db
    .prepare("SELECT COUNT(*) AS n FROM needs WHERE member_id=? AND created_at>=? AND status IN ('open','matching')")
    .bind(requesterId, addMs(now, -7 * DAY))
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= REQUESTER_WEEKLY_CAP) {
    throw new IntroError(T(lang).introCap(open!.n, REQUESTER_WEEKLY_CAP));
  }
  const needId = newId();
  await db
    .prepare("INSERT INTO needs(id, member_id, text, skills_json, status, expires_at, created_at) VALUES (?,?,?,?, 'open', ?, ?)")
    .bind(needId, requesterId, text, JSON.stringify(skills), addMs(now, REQUEST_TTL), now)
    .run();
  await audit(db, "intro.request", requesterId, needId, { skills });
  const { introId, keys } = await nextCandidate(db, needId, now, false);
  return { needId, introId, skills, keys };
}

async function nextCandidate(db: D1Database, needId: string, now: string, notifyNone = true): Promise<{ introId: string | null; keys: string[] }> {
  const need = await db.prepare("SELECT * FROM needs WHERE id=?").bind(needId).first<{ member_id: string; text: string; skills_json: string; status: string; expires_at: string }>();
  if (!need || !["open", "matching"].includes(need.status)) return { introId: null, keys: [] };
  const tried = new Set(
    (await db.prepare("SELECT candidate_id FROM intros WHERE need_id=?").bind(needId).all<{ candidate_id: string }>()).results.map((r) => r.candidate_id),
  );
  const codes = JSON.parse(need.skills_json) as string[];
  const candidates =
    tried.size >= MAX_CANDIDATES || need.expires_at <= now ? [] : await eligibleCandidates(db, need.member_id, codes, now, tried);
  const requester = await contact(db, need.member_id);
  if (!candidates.length) {
    const key = `need:${needId}:no_match`;
    const stmts = [db.prepare("UPDATE needs SET status='no_match' WHERE id=?").bind(needId)];
    if (notifyNone) {
      stmts.push(
        effectStatement(db, key, requester.tg, { text: T(requester.lang).introClosedNoMatch }),
      );
    }
    await db.batch(stmts);
    return { introId: null, keys: notifyNone ? [key] : [] };
  }
  const c = candidates[0]!;
  const id = newId();
  const key = `intro:${id}:invite`;
  const cand = await contact(db, c.member_id);
  const cm = T(cand.lang);
  await db.batch([
    db
      .prepare(
        "INSERT INTO intros(id, need_id, requester_id, candidate_id, status, created_at, updated_at, invite_expires_at, score_json) " +
          "VALUES (?,?,?,?, 'invited', ?, ?, ?, ?)",
      )
      .bind(id, needId, need.member_id, c.member_id, now, now, addMs(now, INVITE_TTL), JSON.stringify({ total: c.total, ...c.components })),
    db.prepare("UPDATE needs SET status='matching' WHERE id=?").bind(needId),
    db
      .prepare("INSERT INTO audit(at, actor, action, subject, detail) VALUES (?,?,?,?,?)")
      .bind(now, "system", "intro.invite", id, JSON.stringify({ total: c.total, components: c.components })),
    effectStatement(db, key, cand.tg, {
      text: cm.introInvite(escapeHtml(labelsFor(codes, cand.lang)), escapeHtml(need.text)),
      buttons: [[btn(cm.bAccept, `i:${id}:accept`), btn(cm.bDecline, `i:${id}:decline`)]],
    }),
  ]);
  return { introId: id, keys: [key] };
}

/** Apply a button press. Returns a short reply and the effect keys to dispatch. */
export async function act(db: D1Database, introId: string, memberId: string, action: string, now = nowIso()): Promise<{ reply: string; keys: string[] }> {
  const event = (["accept", "decline", "confirm", "cancel", "helpful", "noresp"].includes(action) ? (action === "helpful" || action === "noresp" ? "complete" : action) : null) as Event | null;
  const me = T((await db.prepare("SELECT lang FROM members WHERE id=?").bind(memberId).first<{ lang: Lang | null }>())?.lang ?? defaultLang());
  if (!event) return { reply: me.unknownAction, keys: [] };
  const intro = await db.prepare("SELECT * FROM intros WHERE id=?").bind(introId).first<IntroRow>();
  if (!intro) return { reply: me.introGone, keys: [] };
  const actor: Actor | null = memberId === intro.requester_id ? "requester" : memberId === intro.candidate_id ? "candidate" : null;
  if (!actor) return { reply: me.notYours, keys: [] };
  if (event === "accept" && now >= intro.invite_expires_at) return { reply: me.inviteExpired, keys: [] };
  const to = next(intro.status, event, actor);
  if (!to) return { reply: me.alreadyHandledOrNA, keys: [] };
  const outcome = event === "complete" ? (action === "helpful" ? "helpful" : "no_response") : null;
  // Optimistic write: a double click or a concurrent expiry loses the race harmlessly.
  const r = await db
    .prepare("UPDATE intros SET status=?, updated_at=?, outcome=COALESCE(?, outcome) WHERE id=? AND status=?")
    .bind(to, now, outcome, introId, intro.status)
    .run();
  if (!r.meta.changes) return { reply: me.alreadyHandled, keys: [] };
  await audit(db, `intro.${event}`, memberId, introId);
  return after(db, intro, to, actor, now);
}

async function after(db: D1Database, intro: IntroRow, to: Status, actor: Actor, now: string): Promise<{ reply: string; keys: string[] }> {
  const req = await contact(db, intro.requester_id);
  const cand = await contact(db, intro.candidate_id);
  const rm = T(req.lang);
  const cm = T(cand.lang);
  const me = actor === "requester" ? rm : cm;
  const need = await db.prepare("SELECT text FROM needs WHERE id=?").bind(intro.need_id).first<{ text: string }>();
  const quote = `<blockquote>${escapeHtml(need?.text ?? "")}</blockquote>`;
  const id = intro.id;
  if (to === "accepted") {
    const key = `intro:${id}:accepted`;
    await effectStatement(db, key, req.tg, {
      text: rm.introAcceptedToRequester(quote),
      buttons: [[btn(rm.bConfirm, `i:${id}:confirm`), btn(rm.bCancel, `i:${id}:cancel`)]],
    }).run();
    return { reply: me.introAcceptedReply, keys: [key] };
  }
  if (to === "declined") {
    const { keys } = await nextCandidate(db, intro.need_id, now);
    return { reply: me.introDeclinedReply, keys };
  }
  if (to === "mutually_confirmed") {
    const k1 = `intro:${id}:reveal:req`;
    const k2 = `intro:${id}:reveal:cand`;
    const fb = (m: typeof rm) => [[btn(m.bHelped, `i:${id}:helpful`), btn(m.bDidntHappen, `i:${id}:noresp`)]];
    await db.batch([
      effectStatement(db, k1, req.tg, { text: rm.introConnectedReq, buttons: fb(rm), reveal_tg_id: cand.tg }),
      effectStatement(db, k2, cand.tg, { text: cm.introConnectedCand(quote), buttons: fb(cm), reveal_tg_id: req.tg }),
    ]);
    return { reply: me.introConfirmedReply, keys: [k1, k2] };
  }
  if (to === "cancelled") {
    const key = `intro:${id}:cancelled`;
    const other = actor === "requester" ? cand : req;
    await db.batch([
      db.prepare("UPDATE needs SET status='cancelled' WHERE id=? AND status IN ('open','matching')").bind(intro.need_id),
      effectStatement(db, key, other.tg, { text: T(other.lang).introCancelledNotice }),
    ]);
    return { reply: me.introCancelledReply, keys: [key] };
  }
  if (to === "completed") {
    await db.prepare("UPDATE needs SET status='closed' WHERE id=?").bind(intro.need_id).run();
    return { reply: me.introCompletedReply, keys: [] };
  }
  return { reply: me.done, keys: [] };
}

export async function cancelNeed(db: D1Database, requesterId: string, needId: string, now = nowIso()): Promise<{ ok: boolean; keys: string[] }> {
  const keys: string[] = [];
  const live = await db
    .prepare("SELECT id FROM intros WHERE need_id=? AND requester_id=? AND status IN ('invited','accepted','mutually_confirmed')")
    .bind(needId, requesterId)
    .all<{ id: string }>();
  for (const r of live.results) keys.push(...(await act(db, r.id, requesterId, "cancel", now)).keys);
  const res = await db
    .prepare("UPDATE needs SET status='cancelled' WHERE id=? AND member_id=? AND status IN ('open','matching','no_match')")
    .bind(needId, requesterId)
    .run();
  return { ok: res.meta.changes > 0 || live.results.length > 0, keys };
}

/** System sweep (P09-05): expire invitations after 72h and requests after 14 days. */
export async function expireDue(db: D1Database, now = nowIso()): Promise<string[]> {
  const keys: string[] = [];
  const due = await db
    .prepare(
      "SELECT i.* FROM intros i JOIN needs n ON n.id = i.need_id WHERE " +
        "(i.status='invited' AND i.invite_expires_at <= ?) OR (i.status IN ('invited','accepted') AND n.expires_at <= ?) LIMIT 50",
    )
    .bind(now, now)
    .all<IntroRow>();
  for (const intro of due.results) {
    const r = await db.prepare("UPDATE intros SET status='expired', updated_at=? WHERE id=? AND status=?").bind(now, intro.id, intro.status).run();
    if (!r.meta.changes) continue;
    await audit(db, "intro.expire", "system", intro.id);
    keys.push(...(await nextCandidate(db, intro.need_id, now)).keys);
  }
  await db.prepare("UPDATE needs SET status='expired' WHERE status IN ('open','matching') AND expires_at <= ?").bind(now).run();
  return keys;
}

/** One reminder after 24h, only for opted-in candidates of still-open invitations (P09-08). */
export async function sendReminders(db: D1Database, now = nowIso()): Promise<string[]> {
  const rows = await db
    .prepare(
      "SELECT i.id, m.tg_id, m.lang FROM intros i JOIN members m ON m.id = i.candidate_id WHERE i.status='invited' " +
        "AND i.reminder_sent_at IS NULL AND i.created_at <= ? AND i.invite_expires_at > ? AND m.reminders=1 AND m.removed_at IS NULL LIMIT 50",
    )
    .bind(addMs(now, -REMINDER_AFTER), now)
    .all<{ id: string; tg_id: number; lang: Lang | null }>();
  const keys: string[] = [];
  for (const r of rows.results) {
    const key = `intro:${r.id}:reminder`;
    const [upd] = await db.batch([
      db.prepare("UPDATE intros SET reminder_sent_at=? WHERE id=? AND reminder_sent_at IS NULL AND status='invited'").bind(now, r.id),
      effectStatement(db, key, r.tg_id, {
        text: T(r.lang ?? defaultLang()).introReminder,
        buttons: [[btn(T(r.lang ?? defaultLang()).bAccept, `i:${r.id}:accept`), btn(T(r.lang ?? defaultLang()).bDecline, `i:${r.id}:decline`)]],
      }),
    ]);
    if (upd!.meta.changes) keys.push(key);
  }
  return keys;
}
