// The owner's board (ADR-007, item 1): what needs a decision today, in one card, edited in place.
// Sections: join requests, suspicious messages, unanswered requests, repeated questions, and
// (operators only) gaps. Every decision is checked against the group it belongs to. A day with
// nothing to decide sends nothing: silence is the default.

import type { App } from "../bot";
import { chatAdminIds, isChatAdmin, isOperator, managedChats } from "../admins";
import { memberByTg, ensureMember, langOf } from "../acl";
import { citation } from "../ingest";
import { effectStatement, type Payload } from "../outbox";
import { digestHour, ownerIds, timezone } from "../env";
import { escapeHtml, snippet } from "../text";
import { DAY, localParts, nowIso } from "../util";
import type { InlineButton } from "../telegram";
import { decideBest, topicLabel } from "./best";
import { setVerdict } from "./gate";
import { decideJoin } from "./join";
import { executeLive } from "./live";
import { dismissSpam, executeModerate } from "./spam";
import { census, censusView, CENSUS_DAYS, NEWCOMER_MIN, newcomersOf } from "./jobs";
import { isoWeek, launchRounds } from "./rounds";
import { onboardingCard } from "../welcome";
import { btn, T2 } from "./texts";

/** Newcomers who get the onboarding card from one press of "Познакомить". The rest wait for the next week. */
const NEWCOMER_SEND_MAX = 30;

export interface Scope {
  ids: string[];
  operator: boolean;
}

export interface Counts {
  j: number;
  p: number;
  l: number;
  b: number;
  /** Groups with newcomers who have had no useful contact (plan: the board's action line). */
  n: number;
  g: number;
}

const ZERO: Counts = { j: 0, p: 0, l: 0, b: 0, n: 0, g: 0 };

/** The groups a person may decide for: operators see all; others, the groups where they are an admin. */
export async function scopeOf(app: App, tgId: number): Promise<Scope> {
  if (isOperator(app, tgId)) {
    const { results } = await app.db.prepare("SELECT id FROM sources WHERE enabled=1").all<{ id: string }>();
    return { ids: results.map((r) => r.id), operator: true };
  }
  const chats = await managedChats(app, tgId);
  if (!chats.length) return { ids: [], operator: false };
  const { results } = await app.db
    .prepare("SELECT id FROM sources WHERE enabled=1 AND chat_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(chats))
    .all<{ id: string }>();
  return { ids: results.map((r) => r.id), operator: false };
}

export async function countsOf(db: D1Database, scope: Scope): Promise<Counts> {
  if (!scope.ids.length && !scope.operator) return ZERO;
  const ids = JSON.stringify(scope.ids);
  const n = async (sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;
  return {
    j: await n("SELECT COUNT(*) AS n FROM join_screens WHERE status='pending_owner' AND source_id IN (SELECT value FROM json_each(?))", ids),
    p: await n("SELECT COUNT(*) AS n FROM spam_flags WHERE status='pending' AND source_id IN (SELECT value FROM json_each(?))", ids),
    l: await n(
      "SELECT COUNT(*) AS n FROM concierge_cases c JOIN passages p ON 'p:' || p.id = c.subject AND p.body IS NOT NULL AND p.removed_at IS NULL " +
        "WHERE c.mode='live' AND c.verdict IS NULL AND c.executed=0 AND c.action IS NOT NULL AND c.source_id IN (SELECT value FROM json_each(?))",
      ids,
    ),
    b: await n("SELECT COUNT(*) AS n FROM answer_proposals WHERE status='pending' AND source_id IN (SELECT value FROM json_each(?))", ids),
    n: (await openNewcomers(db, scope.ids)).length,
    g: scope.operator ? await n("SELECT COUNT(*) AS n FROM gap_signals WHERE status IN ('new','notified')") : 0,
  };
}

interface Item {
  text: string;
  actions: InlineButton[][];
}

/** The item at `offset` in a section, rendered. Null when there isn't one (or it has gone stale). */
async function itemAt(app: App, sec: string, offset: number, scope: Scope, lang: "en" | "ru"): Promise<Item | null> {
  const db = app.db;
  const ids = JSON.stringify(scope.ids);
  const t = T2(lang);
  if (sec === "j") {
    const r = await db
      .prepare("SELECT id FROM join_screens WHERE status='pending_owner' AND source_id IN (SELECT value FROM json_each(?)) ORDER BY created_at LIMIT 1 OFFSET ?")
      .bind(ids, offset)
      .first<{ id: string }>();
    if (!r) return null;
    const s = await db
      .prepare("SELECT js.applicant_tg, js.answers, js.source_id, src.title FROM join_screens js JOIN sources src ON src.id = js.source_id WHERE js.id=?")
      .bind(r.id)
      .first<{ applicant_tg: number; answers: string; source_id: string; title: string | null }>();
    if (!s) return null;
    const answers = JSON.parse(s.answers || "[]") as string[];
    const complete = answers.length === 3 && answers.every((a) => a.length > 0);
    const who = `<a href="tg://user?id=${s.applicant_tg}">${t.profile}</a>`;
    const lines = [t.joinItem(who, escapeHtml(s.title ?? "")), ""];
    lines.push(...(answers.length ? [t.joinAnswers, ...answers.map((a, i) => `${i + 1}. ${escapeHtml(snippet(a || "—", [], 200))}`)] : [t.joinNoAnswers]));
    lines.push("", complete ? t.joinProposal : t.joinNoProposal);
    return { text: lines.join("\n"), actions: [[btn(t.bAccept, `bd:j:y:${r.id}`), btn(t.bDecline, `bd:j:n:${r.id}`)]] };
  }
  if (sec === "p") {
    const r = await db
      .prepare("SELECT id FROM spam_flags WHERE status='pending' AND source_id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 1 OFFSET ?")
      .bind(ids, offset)
      .first<{ id: number }>();
    if (!r) return null;
    const f = await db
      .prepare("SELECT f.chat_id, f.msg_id, f.reasons, src.username FROM spam_flags f JOIN sources src ON src.id = f.source_id WHERE f.id=?")
      .bind(r.id)
      .first<{ chat_id: number; msg_id: number; reasons: string; username: string | null }>();
    if (!f) return null;
    const reasons = (JSON.parse(f.reasons) as string[]).map((x) => t.spamReason[x] ?? x).join("; ");
    const link = citation(f.chat_id, f.msg_id, f.username);
    return {
      text: `${t.spamItem(escapeHtml(reasons))}\n${link ? `<a href="${escapeHtml(link)}">${t.boardOpen}</a>` : ""}`,
      actions: [[btn(t.bDelete, `bd:p:y:${r.id}`), btn(t.bNotSpam, `bd:p:n:${r.id}`)]],
    };
  }
  if (sec === "l") {
    const r = await db
      .prepare(
        "SELECT c.id FROM concierge_cases c JOIN passages p ON 'p:' || p.id = c.subject AND p.body IS NOT NULL AND p.removed_at IS NULL " +
          "WHERE c.mode='live' AND c.verdict IS NULL AND c.executed=0 AND c.action IS NOT NULL AND c.source_id IN (SELECT value FROM json_each(?)) ORDER BY c.id LIMIT 1 OFFSET ?",
      )
      .bind(ids, offset)
      .first<{ id: number }>();
    if (!r) return null;
    const c = await db
      .prepare("SELECT c.action, c.answer, c.question, p.body FROM concierge_cases c JOIN passages p ON 'p:' || p.id = c.subject WHERE c.id=?")
      .bind(r.id)
      .first<{ action: string; answer: string | null; question: string | null; body: string }>();
    if (!c) return null;
    const detail = c.action === "answer" ? c.answer ?? "" : c.action === "clarify" ? c.question ?? "" : "";
    const proposal = t.liveProposal(t.liveAction[c.action] ?? c.action, escapeHtml(snippet(detail, [], 300)));
    return {
      text: `${t.liveItem(escapeHtml(snippet(c.body, [], 200)))}\n${proposal}`,
      actions: [
        [btn(t.bExecute, `bd:l:y:${r.id}`), btn(t.bNotThat, `bd:l:n:${r.id}`)],
        [btn(t.bSkip, `bd:l:s:${r.id}`)],
      ],
    };
  }
  if (sec === "b") {
    const r = await db
      .prepare("SELECT id FROM answer_proposals WHERE status='pending' AND source_id IN (SELECT value FROM json_each(?)) ORDER BY created_at LIMIT 1 OFFSET ?")
      .bind(ids, offset)
      .first<{ id: string }>();
    if (!r) return null;
    const p = await db.prepare("SELECT source_id, code, question_msg, answer_msg FROM answer_proposals WHERE id=?").bind(r.id).first<{ source_id: string; code: string; question_msg: number; answer_msg: number }>();
    if (!p) return null;
    const q = await db.prepare("SELECT body FROM passages WHERE source_id=? AND msg_id=? AND part=0 AND removed_at IS NULL").bind(p.source_id, p.question_msg).first<{ body: string | null }>();
    const a = await db.prepare("SELECT body FROM passages WHERE source_id=? AND msg_id=? AND part=0 AND removed_at IS NULL").bind(p.source_id, p.answer_msg).first<{ body: string | null }>();
    if (!q?.body || !a?.body) {
      // The reply or question was deleted: the proposal no longer has a text to show.
      await db.prepare("UPDATE answer_proposals SET status='skipped', decided_at=? WHERE id=?").bind(nowIso(), r.id).run();
      return null;
    }
    return {
      text: t.bestItem(escapeHtml(topicLabel(p.code, lang)), escapeHtml(snippet(q.body, [], 160)), escapeHtml(snippet(a.body, [], 400))),
      actions: [[btn(t.bMakeBest, `bd:b:y:${r.id}`), btn(t.bNotThat, `bd:b:n:${r.id}`)], [btn(t.bSkip, `bd:b:s:${r.id}`)]],
    };
  }
  if (sec === "n") {
    // One group at a time: the one with the most newcomers without contact first.
    const g = (await openNewcomers(db, scope.ids))[offset];
    if (!g) return null;
    const src = await db.prepare("SELECT title FROM sources WHERE id=?").bind(g.id).first<{ title: string | null }>();
    return {
      text: t.newcomersItem(escapeHtml(src?.title ?? ""), g.n),
      actions: [[btn(t.bRound, `bd:n:r:${g.id}`), btn(t.bIntro, `bd:n:i:${g.id}`)]],
    };
  }
  if (sec === "g" && scope.operator) {
    const g = await db
      .prepare("SELECT job_code, members FROM gap_signals WHERE status IN ('new','notified') ORDER BY members DESC LIMIT 1 OFFSET ?")
      .bind(offset)
      .first<{ job_code: string; members: number }>();
    if (!g) return null;
    return {
      text: t.gapLine(escapeHtml(g.job_code), g.members),
      actions: [[btn(t.bGapOffer, `g:${g.job_code}:off`), btn(t.bGapDismiss, `g:${g.job_code}:dis`)]],
    };
  }
  return null;
}

/** The card: the home summary (one button per section) or one section's item, with next and back. */
export async function boardView(app: App, scope: Scope, lang: "en" | "ru", sec: string | null, offset = 0): Promise<{ text: string; buttons: InlineButton[][] }> {
  const t = T2(lang);
  const c = await countsOf(app.db, scope);
  const total = c.j + c.p + c.l + c.b + c.n + c.g;
  if (!sec) {
    if (!total) return { text: t.boardQuiet, buttons: [] };
    const rows: [string, number, string][] = [
      ["j", c.j, t.secJoin(c.j)],
      ["p", c.p, t.secSpam(c.p)],
      ["l", c.l, t.secLive(c.l)],
      ["b", c.b, t.secBest(c.b)],
      ["n", c.n, t.secNewcomers(c.n)],
      ["g", c.g, t.secGaps(c.g)],
    ];
    return {
      text: t.boardHead(total),
      buttons: rows.filter(([, n]) => n > 0).map(([k, , label]) => [btn(label, `bd:v:${k}:0`)]),
    };
  }
  const count = c[sec as keyof Counts] ?? 0;
  const item = count ? await itemAt(app, sec, offset, scope, lang) : null;
  if (!item) return boardView(app, scope, lang, null);
  const nav = [btn(t.boardBack, "bd:h:0:0")];
  if (offset + 1 < count) nav.push(btn(t.boardNext, `bd:v:${sec}:${offset + 1}`));
  return { text: item.text, buttons: [...item.actions, nav] };
}

interface Target {
  sourceId: string | null;
  chatId: number | null;
}

async function targetOf(db: D1Database, sec: string, id: string): Promise<Target | null> {
  if (sec === "j") return db.prepare("SELECT source_id AS sourceId, chat_id AS chatId FROM join_screens WHERE id=?").bind(id).first<Target>();
  if (sec === "p")
    return db.prepare("SELECT f.source_id AS sourceId, f.chat_id AS chatId FROM spam_flags f WHERE f.id=?").bind(Number(id)).first<Target>();
  if (sec === "l")
    return db
      .prepare("SELECT c.source_id AS sourceId, s.chat_id AS chatId FROM concierge_cases c JOIN sources s ON s.id = c.source_id WHERE c.id=?")
      .bind(Number(id))
      .first<Target>();
  if (sec === "b")
    return db
      .prepare("SELECT a.source_id AS sourceId, s.chat_id AS chatId FROM answer_proposals a JOIN sources s ON s.id = a.source_id WHERE a.id=?")
      .bind(id)
      .first<Target>();
  if (sec === "n") return db.prepare("SELECT id AS sourceId, chat_id AS chatId FROM sources WHERE id=?").bind(id).first<Target>();
  return null;
}

async function mayDecide(app: App, tgId: number, target: Target): Promise<boolean> {
  if (isOperator(app, tgId)) return true;
  return target.chatId !== null && (await isChatAdmin(app, target.chatId, tgId));
}

export interface CallbackQueryLike {
  id: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
}

/** Buttons `bd:*`. Views edit the card; decisions apply and then show the section's next item. */
export async function boardCallback(app: App, cb: CallbackQueryLike, data: string, now = new Date()): Promise<string[]> {
  const [, sec = "", act = "", id = ""] = data.split(":");
  const lang = langOf(await memberByTg(app.db, cb.from.id));
  const t = T2(lang);
  const answer = (text = "") => app.tg.call("answerCallbackQuery", { callback_query_id: cb.id, text: text.slice(0, 190) }).catch(() => undefined);
  const scope = await scopeOf(app, cb.from.id);
  if (sec === "h") {
    await answer();
    await show(app, cb, await boardView(app, scope, lang, null));
    return [];
  }
  if (sec === "v") {
    await answer();
    await show(app, cb, await boardView(app, scope, lang, act, Number(id) || 0));
    return [];
  }
  const target = await targetOf(app.db, sec, id);
  if (!target) {
    await answer(t.alreadyDone);
    return [];
  }
  if (!(await mayDecide(app, cb.from.id, target))) {
    await answer(t.notYours);
    return [];
  }
  let keys: string[] = [];
  let note = t.done;
  const yes = act === "y";
  if (sec === "j") {
    const r = await decideJoin(app, id, yes, now);
    note = r === "ok" ? t.done : r === "gone" ? t.alreadyDone : t.failed;
  } else if (sec === "p") {
    if (yes) {
      const r = await executeModerate(app, Number(id), now);
      if (r === "removed") await setVerdict(app.db, `spam:${id}`, "good", now);
      note = r === "removed" ? t.done : r === "gone" ? t.alreadyDone : t.failed;
    } else {
      note = (await dismissSpam(app, Number(id), now)) === "ok" ? t.done : t.alreadyDone;
    }
  } else if (sec === "l") {
    if (act === "s") await setVerdict(app.db, `p:${await passageOf(app.db, Number(id))}`, "skip", now);
    if (act === "n") await setVerdict(app.db, `p:${await passageOf(app.db, Number(id))}`, "bad", now);
    if (yes) {
      const subject = `p:${await passageOf(app.db, Number(id))}`;
      const r = await executeLive(app, Number(id), now);
      keys = r.keys;
      await setVerdict(app.db, subject, r.skipped ? "skip" : "good", now);
      note = r.skipped ? t.liveSkipped : t.done;
    }
  } else if (sec === "n") {
    const r = await newcomerAction(app, id, act, now, lang);
    note = r.note;
    keys = r.keys;
  } else if (sec === "b") {
    const verdict = yes ? "accept" : act === "n" ? "decline" : "skip";
    note = (await decideBest(app.db, id, verdict, now)) === "ok" ? t.done : t.alreadyDone;
  }
  await answer(note);
  await show(app, cb, await boardView(app, scope, lang, sec, 0));
  return keys;
}

/** A live case's subject is its passage. */
async function passageOf(db: D1Database, caseId: number): Promise<number> {
  const r = await db.prepare("SELECT subject FROM concierge_cases WHERE id=?").bind(caseId).first<{ subject: string }>();
  return Number(r?.subject.slice(2) ?? 0);
}

async function show(app: App, cb: CallbackQueryLike, v: { text: string; buttons: InlineButton[][] }): Promise<void> {
  if (!cb.message) return;
  const params = { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: v.text, parse_mode: "HTML", reply_markup: { inline_keyboard: v.buttons } };
  await app.tg.call("editMessageText", params).catch(() => app.tg.sendMessage(cb.message!.chat.id, v.text, { buttons: v.buttons }));
}

/** /board in private: the card for everything the person can decide. */
export async function boardCommand(app: App, chat: number, tgId: number, langCode?: string): Promise<string[]> {
  const mem = await ensureMember(app.db, tgId, undefined, langCode);
  const lang = langOf(mem);
  const scope = await scopeOf(app, tgId);
  if (!scope.ids.length) {
    await app.tg.sendMessage(chat, T2(lang).boardCommandNone);
    return [];
  }
  const v = await boardView(app, scope, lang, null);
  await app.tg.sendMessage(chat, v.text, { buttons: v.buttons });
  return [];
}

/** Cron, once a day at the digest hour: one card to each person who manages something that needs a decision. */
export async function boardDaily(app: App, now = new Date()): Promise<number> {
  const tz = timezone(app.env);
  const lp = localParts(now, tz);
  if (lp.hour !== digestHour(app.env)) return 0;
  const guard = await app.db.prepare("SELECT value FROM settings WHERE key='board.day'").first<{ value: string }>();
  if (guard?.value === lp.date) return 0;
  await app.db.prepare("INSERT INTO settings(key, value) VALUES ('board.day', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(lp.date).run();
  const { results: sources } = await app.db.prepare("SELECT id, chat_id FROM sources WHERE enabled=1").all<{ id: string; chat_id: number }>();
  const recipients = new Map<number, Set<string>>();
  const add = (tg: number, id: string) => recipients.set(tg, (recipients.get(tg) ?? new Set()).add(id));
  for (const s of sources) {
    await storeNewcomers(app.db, s.id, now);
    const c = await countsOf(app.db, { ids: [s.id], operator: false });
    if (!c.j && !c.p && !c.l && !c.b && !c.n) continue;
    for (const tg of await chatAdminIds(app, s.chat_id)) add(tg, s.id);
  }
  for (const tg of ownerIds(app.env)) for (const s of sources) add(tg, s.id);
  let sent = 0;
  for (const [tg, ids] of recipients) {
    const who = await app.db.prepare("SELECT lang FROM members WHERE tg_id=?").bind(tg).first<{ lang: string | null }>();
    const lang = who?.lang === "ru" ? "ru" : "en";
    const scope: Scope = { ids: [...ids], operator: ownerIds(app.env).has(tg) };
    const v = await boardView(app, scope, lang, null);
    if (!v.buttons.length) continue; // nothing to decide: no message
    const payload: Payload = { text: v.text, buttons: v.buttons };
    await effectStatement(app.db, `board:${lp.date}:${tg}`, tg, payload).run();
    sent += 1;
  }
  return sent;
}

// ---- newcomers without contact (plan: the board's action line) ------------------------------------

interface NewcomerNote {
  id: string;
  /** People in the group, as the daily run counted them. */
  n: number;
  /** The ISO week the owner last acted on this group's newcomers, or null. */
  acted: string | null;
}

async function newcomerNotes(db: D1Database, ids: string[]): Promise<NewcomerNote[]> {
  if (!ids.length) return [];
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key IN (SELECT 'newcomers.' || value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .all<{ key: string; value: string }>();
  return results.map((r) => ({ id: r.key.slice("newcomers.".length), ...(JSON.parse(r.value) as { n: number; acted: string | null }) }));
}

/** The groups with a newcomers item this week: enough people, and no action taken on them this week yet. */
async function openNewcomers(db: D1Database, ids: string[], now = new Date()): Promise<NewcomerNote[]> {
  const week = isoWeek(now);
  return (await newcomerNotes(db, ids))
    .filter((x) => x.n >= NEWCOMER_MIN && x.acted !== week)
    .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
}

/** The daily run's count for one group. The week the owner acted is kept, so the item stays hidden. */
async function storeNewcomers(db: D1Database, sourceId: string, now: Date): Promise<void> {
  const key = `newcomers.${sourceId}`;
  const n = (await newcomersOf(db, sourceId, now)).length;
  const cur = await db.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<{ value: string }>();
  const acted = cur ? (JSON.parse(cur.value) as { acted: string | null }).acted : null;
  await db
    .prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(key, JSON.stringify({ n, acted }))
    .run();
}

async function markActed(db: D1Database, sourceId: string, week: string): Promise<void> {
  const key = `newcomers.${sourceId}`;
  const cur = await db.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<{ value: string }>();
  const v = cur ? (JSON.parse(cur.value) as { n: number; acted: string | null }) : { n: 0, acted: null };
  await db
    .prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(key, JSON.stringify({ ...v, acted: week }))
    .run();
}

/** "Познакомить": each newcomer without contact gets the onboarding card (what they can help with, what they seek). */
async function introduceNewcomers(app: App, sourceId: string, now: Date): Promise<string[]> {
  const keys: string[] = [];
  const cards = new Map<"en" | "ru", { text: string; buttons: InlineButton[][] }>();
  for (const id of (await newcomersOf(app.db, sourceId, now)).slice(0, NEWCOMER_SEND_MAX)) {
    const who = await app.db.prepare("SELECT tg_id, lang FROM members WHERE id=?").bind(id).first<{ tg_id: number; lang: string | null }>();
    if (!who) continue;
    const lang = who.lang === "ru" ? "ru" : "en";
    let card = cards.get(lang);
    if (!card) {
      card = await onboardingCard(app, sourceId, lang);
      cards.set(lang, card);
    }
    const key = `newcomer:${sourceId}:${who.tg_id}`;
    await effectStatement(app.db, key, who.tg_id, { text: card.text, buttons: card.buttons }).run();
    keys.push(key);
  }
  return keys;
}

/** The two buttons on a newcomers item: run this week's round, or introduce them to the club. One per week. */
async function newcomerAction(app: App, sourceId: string, act: string, now: Date, lang: "en" | "ru"): Promise<{ note: string; keys: string[] }> {
  const t = T2(lang);
  const week = isoWeek(now);
  const current = (await newcomerNotes(app.db, [sourceId]))[0];
  if (current?.acted === week) return { note: t.newcomersDone, keys: [] };
  if (act === "r") {
    const n = await launchRounds(app, sourceId, now);
    await markActed(app.db, sourceId, week);
    return { note: n ? t.roundLaunched(n) : t.roundNone, keys: [] };
  }
  if (act === "i") {
    const keys = await introduceNewcomers(app, sourceId, now);
    await markActed(app.db, sourceId, week);
    return { note: t.newcomersSent(keys.length), keys };
  }
  return { note: t.alreadyDone, keys: [] };
}

/** /jobs in private: what the groups this person manages were asked over the census window. */
export async function jobsCommand(app: App, chat: number, tgId: number, langCode?: string): Promise<string[]> {
  const mem = await ensureMember(app.db, tgId, undefined, langCode);
  const lang = langOf(mem);
  const scope = await scopeOf(app, tgId);
  if (!scope.ids.length) {
    await app.tg.sendMessage(chat, T2(lang).jobsCommandNone);
    return [];
  }
  const c = await census(app.db, scope.ids, nowIso(new Date(Date.now() - CENSUS_DAYS * DAY)));
  const doors = await app.db
    .prepare("SELECT COUNT(*) AS n FROM sources WHERE doors=1 AND enabled=1 AND id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(scope.ids))
    .first<{ n: number }>();
  await app.tg.sendMessage(chat, censusView(c, lang, (doors?.n ?? 0) > 0));
  return [];
}
