// «Нить»: what the asker does with their card (plan: the main mechanism, journeys 3 and 12).
// Opening a request searches the community's memory and paints the answer into one card in the
// asker's private chat. The buttons then move it on: "Спросить людей" (consent-based introduction),
// one of three outcomes, and 🙏 for the person who helped. Every change edits the same card.

import type { App } from "./bot";
import { langOf, type Member } from "./acl";
import { brief } from "./ai/beam";
import { recordAnswer, vote } from "./feedback";
import { T, defaultLang, type Lang } from "./i18n";
import { cancelNeed, IntroError, requestIntro } from "./intros";
import { effectStatement } from "./outbox";
import { answer, type AnswerStatus, type Quote, type SearchFilters } from "./search";
import { applyCard, helpedCount, outcomeButtons, OUTCOMES, renderThread, type Outcome, type ThreadRow, type ThreadState } from "./thread-card";
import { DefiniteFailure } from "./telegram";
import { escapeHtml } from "./text";
import { newId, nowIso } from "./util";

export interface Ask {
  memberId: string;
  /** The asker's private chat (their Telegram id): where the card lives. */
  tgId: number;
  question: string;
  readable: Set<string>;
  filters: SearchFilters;
  lang: Lang;
}

export interface Opened {
  id: string;
  status: AnswerStatus;
  count: number;
}

/**
 * Open a request: one card in the asker's private chat, filled in with the memory's answer.
 * Returns null when Telegram won't let the bot write to them yet (a group falls back to a group reply).
 */
export async function openThread(app: App, ask: Ask, now = new Date()): Promise<Opened | null> {
  const db = app.db;
  const id = newId();
  const at = nowIso(now);
  const m = T(ask.lang);
  await db
    .prepare("INSERT INTO threads(id, member_id, chat_id, question, state, rev, created_at, updated_at) VALUES (?,?,?,?, 'searching', 0, ?, ?)")
    .bind(id, ask.memberId, ask.tgId, ask.question, at, at)
    .run();
  let placed: { message_id: number };
  try {
    placed = await app.tg.sendMessage(ask.tgId, m.threadSearching);
  } catch (e) {
    await db.prepare("DELETE FROM threads WHERE id=?").bind(id).run();
    if (e instanceof DefiniteFailure) return null;
    throw e;
  }
  await db.prepare("UPDATE threads SET message_id=? WHERE id=?").bind(placed.message_id, id).run();
  await db.prepare("INSERT INTO thread_events(thread_id, state, at) VALUES (?, 'searching', ?)").bind(id, at).run();

  const a = await answer(db, ask.readable, ask.question, ask.filters);
  const quotes: Quote[] = a.status === "answered" ? a.quotes : [];
  let answerId: string | null = null;
  let note: string | null = null;
  if (quotes.length) {
    answerId = await recordAnswer(db, ask.memberId, quotes.map((q) => q.id));
    note = await brief(app, ask.readable, ask.question, quotes, ask.lang);
  } else if (a.status === "no_access") note = m.noAccess;
  const state: ThreadState = quotes.length ? "memory" : a.status === "no_access" ? "closed" : "asking";
  await db
    .prepare("UPDATE threads SET state=?, quotes_json=?, brief=?, answer_id=?, answered_at=?, updated_at=?, rev=rev+1 WHERE id=?")
    .bind(state, quotes.length ? JSON.stringify(quotes) : null, note, answerId, quotes.length ? at : null, at, id)
    .run();
  await db.prepare("INSERT INTO thread_events(thread_id, state, at) VALUES (?,?,?)").bind(id, state, at).run();
  await paint(app, id);
  return { id, status: a.status, count: quotes.length };
}

/** Put the thread's current state into its card now (direct edit, used inside a request). */
export async function paint(app: App, threadId: string): Promise<void> {
  const r = await renderThread(app.db, threadId);
  if (!r) return;
  try {
    await applyCard(app.tg, r);
  } catch (e) {
    if (!(e instanceof DefiniteFailure)) throw e;
    // The card was deleted in the chat: send a fresh one and follow that from now on.
    try {
      const sent = await app.tg.sendMessage(r.chatId, r.text, { buttons: r.buttons });
      await app.db.prepare("UPDATE threads SET message_id=? WHERE id=?").bind(sent.message_id, threadId).run();
    } catch (again) {
      if (!(again instanceof DefiniteFailure)) throw again;
    }
  }
}

async function ownThread(db: D1Database, threadId: string, memberId: string): Promise<ThreadRow | null> {
  return db.prepare("SELECT * FROM threads WHERE id=? AND member_id=?").bind(threadId, memberId).first<ThreadRow>();
}

/** Close a thread with its outcome. Returns false if it was already closed (a double tap). */
async function close(db: D1Database, threadId: string, outcome: Outcome, helperId: string | null, at: string): Promise<boolean> {
  const r = await db
    .prepare("UPDATE threads SET outcome=?, helper_id=?, state='closed', closed_at=?, updated_at=?, rev=rev+1 WHERE id=? AND outcome IS NULL")
    .bind(outcome, helperId, at, at, threadId)
    .run();
  if (!r.meta.changes) return false;
  await db.prepare("INSERT INTO thread_events(thread_id, state, at) VALUES (?, 'closed', ?)").bind(threadId, at).run();
  return true;
}

/** "Спросить людей": the same consent-based introduction flow as /intro, started from the card. */
async function askPeople(app: App, mem: Member, t: ThreadRow, now: Date): Promise<string[]> {
  if (t.need_id) {
    await paint(app, t.id);
    return [];
  }
  const lang = langOf(mem);
  try {
    const at = nowIso(now);
    const r = await requestIntro(app.db, mem.id, t.question, at, lang);
    await app.db
      .prepare("UPDATE threads SET need_id=?, state='asking', updated_at=?, rev=rev+1 WHERE id=?")
      .bind(r.needId, at, t.id)
      .run();
    await app.db.prepare("INSERT INTO thread_events(thread_id, state, at) VALUES (?, 'asking', ?)").bind(t.id, at).run();
    await paint(app, t.id);
    return r.keys;
  } catch (e) {
    if (!(e instanceof IntroError)) throw e;
    await app.tg.sendMessage(t.chat_id, e.message);
    return [];
  }
}

/**
 * Button presses on a card: t:<id>:ok | no | ask | cancel | thx | o:<contact|advice|solved>.
 * Returns effect keys to dispatch now (the callback handler answers the toast itself).
 */
export async function threadAction(
  app: App,
  mem: Member,
  threadId: string,
  action: string,
  arg: string,
  toast: (text?: string, alert?: boolean) => Promise<unknown>,
  now = new Date(),
): Promise<string[]> {
  const db = app.db;
  const lang = langOf(mem);
  const m = T(lang);
  const t = await ownThread(db, threadId, mem.id);
  if (!t) {
    await toast(m.notAvailable);
    return [];
  }
  const at = nowIso(now);
  if (action === "ok") {
    if (t.answer_id) await vote(db, t.answer_id, mem.id, "up");
    await close(db, t.id, "solved", null, at);
    await paint(app, t.id);
    await toast(m.threadSolvedToast);
    return [];
  }
  if (action === "no") {
    if (t.answer_id) await vote(db, t.answer_id, mem.id, "down");
    await toast(m.threadNotThatToast);
    return [];
  }
  if (action === "ask") {
    if (t.state === "closed" || t.outcome) {
      await toast(m.notAvailable);
      return [];
    }
    return askPeople(app, mem, t, now);
  }
  if (action === "cancel") {
    if (!t.need_id) return [];
    const r = await cancelNeed(db, mem.id, t.need_id, at);
    await paint(app, t.id);
    await toast(r.ok ? "" : m.notAvailable);
    return r.keys;
  }
  if (action === "o") {
    if (!(OUTCOMES as readonly string[]).includes(arg) || t.outcome) {
      await toast(m.notAvailable);
      return [];
    }
    const outcome = arg as Outcome;
    let helper: string | null = null;
    if (t.need_id) {
      // The person who helped is the one we introduced. Closing the introduction is the asker's call.
      const intro = await db
        .prepare("SELECT id, candidate_id, status FROM intros WHERE need_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .bind(t.need_id)
        .first<{ id: string; candidate_id: string; status: string }>();
      if (intro && (intro.status === "mutually_confirmed" || intro.status === "completed")) {
        await db.batch([
          db
            .prepare("UPDATE intros SET status='completed', outcome=COALESCE(outcome, ?), updated_at=? WHERE id=? AND status IN ('mutually_confirmed','completed')")
            .bind(outcome === "contact" ? "contact" : "helpful", at, intro.id),
          db.prepare("UPDATE needs SET status='closed' WHERE id=? AND status NOT IN ('closed','cancelled','expired')").bind(t.need_id),
        ]);
        helper = intro.candidate_id;
      }
    }
    await close(db, t.id, outcome, helper, at);
    await paint(app, t.id);
    await toast(outcome === "solved" ? m.threadSolvedToast : "");
    return [];
  }
  if (action === "thx") {
    if (!t.helper_id || t.thanked_at) {
      await toast(t.thanked_at ? m.threadThanksSent : m.notAvailable);
      return [];
    }
    const helper = await db.prepare("SELECT tg_id, lang FROM members WHERE id=?").bind(t.helper_id).first<{ tg_id: number; lang: Lang | null }>();
    if (!helper) return [];
    const hm = T(helper.lang ?? defaultLang());
    const key = `thanks:${t.id}`;
    const q = escapeHtml(t.question.slice(0, 120));
    const n = await helpedCount(db, t.helper_id);
    await db.batch([
      db.prepare("UPDATE threads SET thanked_at=?, updated_at=?, rev=rev+1 WHERE id=? AND thanked_at IS NULL").bind(at, at, t.id),
      effectStatement(db, key, helper.tg_id, { text: hm.thanksReceived(q, n) }),
    ]);
    await paint(app, t.id);
    await toast(m.threadThanksSent);
    return [key];
  }
  return [];
}

/**
 * Cron step: ask "Помогло?" once, as a new message (edits are silent, so it needs its own), for
 * introductions whose contacts opened at least FOLLOWUP_AFTER ago and that have no outcome yet.
 */
export async function followupsDue(db: D1Database, now = nowIso()): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT t.id, t.chat_id, m.lang AS lang FROM threads t JOIN members m ON m.id = t.member_id " +
        "WHERE t.outcome IS NULL AND t.state='introduced' AND t.followup_at IS NOT NULL AND t.followup_sent_at IS NULL AND t.followup_at <= ? LIMIT 20",
    )
    .bind(now)
    .all<{ id: string; chat_id: number; lang: Lang | null }>();
  const keys: string[] = [];
  for (const r of results) {
    const claim = await db.prepare("UPDATE threads SET followup_sent_at=? WHERE id=? AND followup_sent_at IS NULL").bind(now, r.id).run();
    if (!claim.meta.changes) continue;
    const key = `thread:${r.id}:followup`;
    const m = T(r.lang ?? defaultLang());
    await effectStatement(db, key, r.chat_id, { text: m.threadFollowupAsk, buttons: outcomeButtons(m, r.id) }).run();
    keys.push(key);
  }
  return keys;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Pilot metrics for the operator (plan: success is measured by outcomes). */
export async function pilotText(db: D1Database, lang: Lang): Promise<string> {
  const m = T(lang);
  const { results } = await db
    .prepare("SELECT created_at, answered_at, need_id, outcome FROM threads")
    .all<{ created_at: string; answered_at: string | null; need_id: string | null; outcome: Outcome | null }>();
  if (!results.length) return m.pilotNone;
  const connected = (await db.prepare("SELECT COUNT(DISTINCT thread_id) AS n FROM thread_events WHERE state='introduced'").first<{ n: number }>())?.n ?? 0;
  const memory = results.filter((r) => r.answered_at).length;
  const asked = results.filter((r) => r.need_id).length;
  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  const speed = median(results.filter((r) => r.answered_at).map((r) => (Date.parse(r.answered_at!) - Date.parse(r.created_at)) / 60_000));
  const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "—");
  return [
    `<b>${m.pilotTitle}</b>`,
    `${m.pilotAll}: <b>${results.length}</b>`,
    `${m.pilotMemory}: <b>${memory}</b> (${pct(memory, results.length)})`,
    `${m.pilotAsked}: <b>${asked}</b>`,
    `${m.pilotConnected}: <b>${connected}</b>`,
    `${m.pilotSolved}: <b>${count("solved")} / ${count("advice")} / ${count("contact")}</b>`,
    `${m.pilotSpeed}: <b>${speed === null ? "—" : `${Math.round(speed)} min`}</b>`,
  ].join("\n");
}

/** Send the card again as a new message (after "/start q…" from a group, or if it was lost). */
export async function resend(app: App, threadId: string, memberId: string): Promise<void> {
  const t = await ownThread(app.db, threadId, memberId);
  if (!t) return;
  const r = await renderThread(app.db, threadId);
  if (!r) return;
  const sent = await app.tg.sendMessage(r.chatId, r.text, { buttons: r.buttons });
  await app.db.prepare("UPDATE threads SET message_id=? WHERE id=?").bind(sent.message_id, threadId).run();
}
