// «Нить»: what the asker does with their card (plan: the main mechanism, journeys 3 and 12).
// Opening a request searches the community's memory and paints the answer into one card in the
// asker's private chat. The buttons then move it on: "Спросить людей" (consent-based introduction),
// one of three outcomes, and 🙏 for the person who helped. Every change edits the same card.

import type { App } from "./bot";
import { langOf, type Member } from "./acl";
import { brief } from "./ai/beam";
import { recordAnswer, vote } from "./feedback";
import { bridgeFromThread, closeBridgeHelpful } from "./alliance";
import { kindOf } from "./concierge/jobs";
import { T2 } from "./concierge/texts";
import { T, defaultLang, type Lang } from "./i18n";
import { cancelNeed, IntroError, NoSkillError, requestIntro, type Want } from "./intros";
import { labelIn, offeredSkills, TAXONOMY } from "./experts";
import { effectStatement } from "./outbox";
import { answer, type AnswerStatus, type Quote, type SearchFilters } from "./search";
import { applyCard, btn, dealStatus, helpedCount, outcomeButtons, OUTCOMES, renderThread, type Outcome, type ThreadRow, type ThreadState } from "./thread-card";
import { DefiniteFailure } from "./telegram";
import { escapeHtml, snippet } from "./text";
import { addMs, audit, HOUR, newId, nowIso } from "./util";

export interface Ask {
  memberId: string;
  /** The club the question was asked in, when it was asked in a group (Мост uses it to pick a partner). */
  sourceId?: string | null;
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
    .prepare("INSERT INTO threads(id, member_id, chat_id, question, state, rev, source_id, created_at, updated_at) VALUES (?,?,?,?, 'searching', 0, ?, ?, ?)")
    .bind(id, ask.memberId, ask.tgId, ask.question, ask.sourceId ?? null, at, at)
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

/**
 * "Спросить людей": the same consent-based introduction flow as /intro, started from the card.
 * When the question names no known topic, the person picks one from the topics people in their
 * groups have offered to help with (t:<id>:sk:<code>), instead of hitting a dead end.
 */
async function askPeople(app: App, mem: Member, t: ThreadRow, now: Date, picked?: string): Promise<string[]> {
  if (t.need_id) {
    await paint(app, t.id);
    return [];
  }
  const lang = langOf(mem);
  // Hiring asks for people open to projects, and the answers to the clarifying question go with it.
  // A request for an introduction is matched on the doors people have named (plan: «Нужен выход на…»).
  const kind = kindOf(t.question);
  const want: Want | undefined = kind === "hiring" ? "hire" : kind === "introduction" ? "door" : undefined;
  const text = want === "hire" && t.clarify ? `${t.question}\n${t.clarify}` : t.question;
  try {
    const at = nowIso(now);
    const r = await requestIntro(app.db, mem.id, text, at, lang, picked ? [picked] : undefined, want);
    await app.db
      .prepare("UPDATE threads SET need_id=?, state='asking', updated_at=?, rev=rev+1 WHERE id=?")
      .bind(r.needId, at, t.id)
      .run();
    await app.db.prepare("INSERT INTO thread_events(thread_id, state, at) VALUES (?, 'asking', ?)").bind(t.id, at).run();
    await paint(app, t.id);
    return r.keys;
  } catch (e) {
    if (e instanceof NoSkillError) {
      const m = T(lang);
      const codes = await offeredSkills(app.db, mem.id);
      if (!codes.length) {
        await app.tg.sendMessage(t.chat_id, m.askNoHelpers);
        return [];
      }
      const rows: ReturnType<typeof btn>[][] = [];
      for (let i = 0; i < codes.length; i += 2) rows.push(codes.slice(i, i + 2).map((c) => btn(labelIn(TAXONOMY.get(c)!, lang), `t:${t.id}:sk:${c}`)));
      await app.tg.sendMessage(t.chat_id, m.askPickTopic, { buttons: rows });
      return [];
    }
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
    // A hiring request gets one question first: budget, deadline, format (or skip).
    if (kindOf(t.question) === "hiring" && t.clarify === null && !t.need_id) return askClarify(app, mem, t, now);
    return askPeople(app, mem, t, now);
  }
  if (action === "clr0") {
    // "Пропустить" on the clarifying question: ask people with the request as it is.
    if (t.need_id || t.clarify !== null) {
      await toast(m.notAvailable);
      return [];
    }
    await db.batch([
      db.prepare("UPDATE threads SET clarify='', updated_at=?, rev=rev+1 WHERE id=?").bind(at, t.id),
      db.prepare("DELETE FROM pending_inputs WHERE member_id=? AND kind='clarify'").bind(mem.id),
    ]);
    await toast("");
    return askPeople(app, mem, { ...t, clarify: "" }, now);
  }
  if (action === "open" || action === "openoff") {
    // Open to projects: a person's own switch, needing /optin first so that they can be found.
    const tt = T2(lang);
    const on = action === "open";
    if (on && !mem.discoverable) {
      await toast(tt.openNeedsOptIn, true);
      return [];
    }
    await db.prepare("UPDATE members SET open_work=? WHERE id=?").bind(on ? 1 : 0, mem.id).run();
    await audit(db, "consent.open_work", mem.id, mem.id, { granted: on });
    await paint(app, t.id);
    await toast(on ? tt.openOn : tt.openOff);
    return [];
  }
  if (action === "deal") {
    // "We agreed on the work": only after the introduction connected, and only the asker can propose it.
    const tt = T2(lang);
    const intro = t.need_id ? await connectedIntro(db, t.need_id) : null;
    if (!intro || t.outcome || t.state === "closed" || kindOf(t.question) !== "hiring") {
      await toast(tt.dealNotYet);
      return [];
    }
    if ((await dealStatus(db, intro.id)) === "proposed") {
      await toast(tt.dealWaiting);
      return [];
    }
    const keys = await proposeDeal(app, t, intro, at);
    await paint(app, t.id);
    await toast(tt.dealAskSent);
    return keys;
  }
  if (action === "sk") {
    // A topic picked for "Спросить людей" when the question named none.
    if (t.state === "closed" || t.outcome || !TAXONOMY.has(arg)) {
      await toast(m.notAvailable);
      return [];
    }
    await toast("");
    return askPeople(app, mem, t, now, arg);
  }
  if (action === "bridge") {
    // Explain first (plan: journey 6): only the request text crosses, nothing about the asker.
    await app.tg.sendMessage(t.chat_id, m.bridgeConfirm, { buttons: [[btn(m.bBridgeGo, `t:${t.id}:bridgeok`)]] });
    await toast("");
    return [];
  }
  if (action === "bridgeok") {
    if (t.bridge_id) {
      await toast(m.notAvailable);
      return [];
    }
    const bridged = await bridgeFromThread(db, mem, t.id, t.question, t.source_id ?? null, at);
    if (!bridged.ok) {
      await app.tg.sendMessage(t.chat_id, bridged.text ?? m.bridgeNone);
      return [];
    }
    await paint(app, t.id);
    await toast("");
    return bridged.keys;
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
    // 🙏 asks for a few words first; the next private message is them (see answerPending).
    if (!t.helper_id || t.thanked_at) {
      await toast(t.thanked_at ? m.threadThanksSent : m.notAvailable);
      return [];
    }
    await db
      .prepare("INSERT INTO pending_inputs(member_id, kind, ref, expires_at) VALUES (?, 'thanks', ?, ?) ON CONFLICT(member_id) DO UPDATE SET kind='thanks', ref=excluded.ref, expires_at=excluded.expires_at")
      .bind(mem.id, t.id, addMs(at, HOUR))
      .run();
    await app.tg.sendMessage(t.chat_id, m.thanksAsk, { buttons: [[btn(m.bNoWords, `t:${t.id}:thx0`)]] });
    await toast("");
    return [];
  }
  if (action === "thx0") {
    if (!t.helper_id || t.thanked_at) {
      await toast(t.thanked_at ? m.threadThanksSent : m.notAvailable);
      return [];
    }
    const keys = await sendThanks(app, mem, t, null, at);
    await toast(m.threadThanksSent);
    return keys;
  }
  return [];
}

/** The thank-you goes to the helper, anonymously, with the asker's words if they wrote any. */
async function sendThanks(app: App, mem: Member, t: ThreadRow, words: string | null, at: string): Promise<string[]> {
  const db = app.db;
  const helper = await db.prepare("SELECT tg_id, lang FROM members WHERE id=?").bind(t.helper_id).first<{ tg_id: number; lang: Lang | null }>();
  if (!helper) return [];
  const hm = T(helper.lang ?? defaultLang());
  const key = `thanks:${t.id}`;
  const q = escapeHtml(t.question.slice(0, 120));
  const n = await helpedCount(db, t.helper_id!);
  const text = words ? hm.thanksWithWords(q, escapeHtml(words), n) : hm.thanksReceived(q, n);
  await db.batch([
    db.prepare("UPDATE threads SET thanked_at=?, updated_at=?, rev=rev+1 WHERE id=? AND thanked_at IS NULL").bind(at, at, t.id),
    db.prepare("DELETE FROM pending_inputs WHERE member_id=?").bind(mem.id),
    effectStatement(db, key, helper.tg_id, { text }),
  ]);
  await paint(app, t.id);
  return [key];
}

/** The clarifying question for a hiring request: one message, and the asker's next private text answers it. */
async function askClarify(app: App, mem: Member, t: ThreadRow, now: Date): Promise<string[]> {
  const tt = T2(langOf(mem));
  await app.db
    .prepare(
      "INSERT INTO pending_inputs(member_id, kind, ref, expires_at) VALUES (?, 'clarify', ?, ?) " +
        "ON CONFLICT(member_id) DO UPDATE SET kind='clarify', ref=excluded.ref, expires_at=excluded.expires_at",
    )
    .bind(mem.id, t.id, addMs(nowIso(now), HOUR))
    .run();
  await app.tg.sendMessage(t.chat_id, tt.clarifyAsk, { buttons: [[btn(tt.bClarifySkip, `t:${t.id}:clr0`)]] });
  return [];
}

/** The answer to the clarifying question is kept on the card, and the people are asked with it. */
async function clarifyAnswer(app: App, mem: Member, t: ThreadRow | null, text: string, now: Date): Promise<string[] | null> {
  if (!t || t.need_id || t.clarify !== null) {
    await app.db.prepare("DELETE FROM pending_inputs WHERE member_id=?").bind(mem.id).run();
    return null;
  }
  const words = text.trim().slice(0, 300);
  if (!words) return null;
  await app.db.batch([
    app.db.prepare("UPDATE threads SET clarify=?, updated_at=?, rev=rev+1 WHERE id=?").bind(words, nowIso(now), t.id),
    app.db.prepare("DELETE FROM pending_inputs WHERE member_id=?").bind(mem.id),
  ]);
  return askPeople(app, mem, { ...t, clarify: words }, now);
}

/** The introduction a deal is about: the latest one for the request, once contacts are open. */
async function connectedIntro(db: D1Database, needId: string): Promise<{ id: string; candidate_id: string } | null> {
  return db
    .prepare("SELECT id, candidate_id FROM intros WHERE need_id=? AND status IN ('mutually_confirmed','completed') ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(needId)
    .first<{ id: string; candidate_id: string }>();
}

/** "We agreed on the work": the person the asker was introduced to is asked to confirm it. */
async function proposeDeal(app: App, t: ThreadRow, intro: { id: string; candidate_id: string }, at: string): Promise<string[]> {
  const db = app.db;
  const who = await db.prepare("SELECT tg_id, lang FROM members WHERE id=?").bind(intro.candidate_id).first<{ tg_id: number; lang: Lang | null }>();
  if (!who) return [];
  const tt = T2(who.lang ?? defaultLang());
  const key = `deal:${intro.id}:${at}`;
  await db.batch([
    db
      .prepare(
        "INSERT INTO deals(intro_id, requester_at, candidate_at, status, updated_at) VALUES (?, ?, NULL, 'proposed', ?) " +
          "ON CONFLICT(intro_id) DO UPDATE SET requester_at=excluded.requester_at, candidate_at=NULL, status='proposed', updated_at=excluded.updated_at",
      )
      .bind(intro.id, at, at),
    effectStatement(db, key, who.tg_id, {
      text: tt.dealAsk(escapeHtml(snippet(t.question, [], 120))),
      buttons: [[btn(tt.bDealYes, `dl:${intro.id}:y`), btn(tt.bDealNo, `dl:${intro.id}:n`)]],
    }),
  ]);
  return [key];
}

/**
 * The introduced person's answer to a proposed deal. "Yes" closes the thread as a deal, now that both
 * have confirmed it; "not yet" leaves the thread open, and the asker can ask again.
 */
export async function dealAnswer(app: App, mem: Member, introId: string, yes: boolean, now = new Date()): Promise<{ text: string; keys: string[] }> {
  const db = app.db;
  const m = T(langOf(mem));
  const at = nowIso(now);
  const intro = await db
    .prepare("SELECT id, need_id, candidate_id, status FROM intros WHERE id=?")
    .bind(introId)
    .first<{ id: string; need_id: string; candidate_id: string; status: string }>();
  if (!intro || intro.candidate_id !== mem.id || !["mutually_confirmed", "completed"].includes(intro.status)) return { text: m.notAvailable, keys: [] };
  const t = await db.prepare("SELECT * FROM threads WHERE need_id=? AND outcome IS NULL ORDER BY created_at DESC LIMIT 1").bind(intro.need_id).first<ThreadRow>();
  if (!t) return { text: m.notAvailable, keys: [] };
  if (yes) {
    const r = await db.prepare("UPDATE deals SET status='agreed', candidate_at=?, updated_at=? WHERE intro_id=? AND status='proposed'").bind(at, at, intro.id).run();
    if (!r.meta.changes) return { text: m.notAvailable, keys: [] };
    await close(db, t.id, "solved", intro.candidate_id, at); // shown as a deal: see dealAgreed in thread-card.ts
    await paint(app, t.id);
    return { text: T2(langOf(mem)).dealConfirmed, keys: [] };
  }
  const r = await db.prepare("UPDATE deals SET status='declined', candidate_at=NULL, updated_at=? WHERE intro_id=? AND status='proposed'").bind(at, intro.id).run();
  if (r.meta.changes) await paint(app, t.id);
  return { text: T2(langOf(mem)).dealDeclinedHelper, keys: [] };
}

/**
 * The asker's next private message after 🙏 is the thank-you's words, if the prompt is still open
 * (an hour). Returns the effect keys to dispatch, or null when the message is an ordinary one.
 */
export async function answerPending(app: App, mem: Member, text: string, now = new Date()): Promise<string[] | null> {
  const at = nowIso(now);
  const pending = await app.db.prepare("SELECT kind, ref, expires_at FROM pending_inputs WHERE member_id=?").bind(mem.id).first<{ kind: string; ref: string; expires_at: string }>();
  if (!pending) return null;
  if (pending.kind !== "thanks" && pending.kind !== "clarify") return null; // e.g. a join screening: answered by that flow
  if (pending.expires_at <= at) {
    await app.db.prepare("DELETE FROM pending_inputs WHERE member_id=?").bind(mem.id).run();
    return null;
  }
  const t = await ownThread(app.db, pending.ref, mem.id);
  if (pending.kind === "clarify") return clarifyAnswer(app, mem, t, text, now);
  if (!t || !t.helper_id || t.thanked_at) {
    await app.db.prepare("DELETE FROM pending_inputs WHERE member_id=?").bind(mem.id).run();
    return null;
  }
  const words = text.trim().slice(0, 300);
  if (!words) return null;
  const keys = await sendThanks(app, mem, t, words, at);
  await app.tg.sendMessage(mem.tg_id, T(langOf(mem)).threadThanksSent);
  return keys;
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

/** "Помогло" on a bridged request: the request closes, the helping club is credited, the card closes. */
export async function bridgeHelpful(app: App, mem: Member, bridgeId: string, now = new Date()): Promise<{ ok: boolean; keys: string[] }> {
  const at = nowIso(now);
  const t = await app.db.prepare("SELECT id FROM threads WHERE bridge_id=? AND member_id=? AND outcome IS NULL").bind(bridgeId, mem.id).first<{ id: string }>();
  const closed = await closeBridgeHelpful(app.db, mem, bridgeId, at);
  if (!closed) return { ok: false, keys: [] };
  if (t) {
    await close(app.db, t.id, "solved", null, at);
    await paint(app, t.id);
  }
  return { ok: true, keys: [] };
}
