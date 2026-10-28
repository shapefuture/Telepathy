// «Нить»: the living request card (plan: the main mechanism). One message per request, edited in
// place as it moves: searching → memory answer → asking people → introduced → closed.
// A card is always rendered from the database when it is sent, so an edit queued earlier can't
// overwrite a newer state with stale text. This module imports nothing that imports it back.

import { readable, memberById } from "./acl";
import { kindOf, recommendationsFor } from "./concierge/jobs";
import { T2 } from "./concierge/texts";
import { defaultLang, T, type Lang, type Messages } from "./i18n";
import type { Quote } from "./search";
import type { InlineButton, Telegram } from "./telegram";
import { askable } from "./experts";
import { escapeHtml, quoteHtml } from "./text";
import { addMs, DAY, nowIso } from "./util";

/** "Помогло?" comes this long after contacts were opened (plan: "a few days later"). */
export const FOLLOWUP_AFTER = 3 * DAY;

export type ThreadState = "searching" | "memory" | "asking" | "introduced" | "closed";
export type Outcome = "contact" | "advice" | "solved";
export const OUTCOMES: readonly Outcome[] = ["contact", "advice", "solved"];

/** Faces for people who haven't opted in to a name. Chosen by a stable hash of the member id. */
const FACES = ["🙂", "😊", "🧑", "🧔", "👩", "👨", "🧓", "👵", "👴", "🧕", "👳", "🧑‍🎨", "🧑‍🏫", "🧑‍🔬", "🧑‍🍳", "🧑‍💻", "🧑‍🌾", "🧑‍🚀", "🧑‍🔧", "🧑‍🎤", "👩‍🦰", "👨‍🦱", "🧑‍🦳", "🧑‍⚕️"];

export function faceOf(memberId: string): string {
  let h = 0;
  for (const c of memberId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return FACES[h % FACES.length]!;
}

export interface ThreadRow {
  id: string;
  member_id: string;
  chat_id: number;
  message_id: number | null;
  question: string;
  state: ThreadState;
  quotes_json: string | null;
  brief: string | null;
  /** The asker's answer to the clarifying question: null = not asked yet, '' = skipped. */
  clarify: string | null;
  answer_id: string | null;
  need_id: string | null;
  outcome: Outcome | null;
  helper_id: string | null;
  thanked_at: string | null;
  followup_at: string | null;
  followup_sent_at: string | null;
  rev: number;
  source_id?: string | null;
  bridge_id?: string | null;
}

export interface Rendered {
  chatId: number;
  messageId: number;
  text: string;
  buttons: InlineButton[][];
}

interface IntroRow {
  id: string;
  status: string;
  candidate_id: string;
  requester_id: string;
}

const CONNECTED: ReadonlySet<string> = new Set(["mutually_confirmed", "completed"]);

export const btn = (text: string, data: string): InlineButton => ({ text, callback_data: data });

const localeOf = (lang: Lang) => (lang === "ru" ? "ru-RU" : "en-GB");

/** Month and year only: a memory is dated, not timed ("Анна · март 2026"). */
export const monthLabel = (iso: string, lang: Lang) => new Intl.DateTimeFormat(localeOf(lang), { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(iso));

/** Display names for the people on a card. Only members who opted in have one. */
export async function namesFor(db: D1Database, ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!ids.length) return out;
  const { results } = await db
    .prepare("SELECT id, display_name FROM members WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...new Set(ids)]))
    .all<{ id: string; display_name: string | null }>();
  for (const r of results) out.set(r.id, r.display_name);
  return out;
}

/** "🙂 Анна" for someone who opted in, "😊 Участник" otherwise. */
export function personLabel(memberId: string, name: string | null | undefined, m: Messages): string {
  return `${faceOf(memberId)} ${name ? escapeHtml(name) : m.memberAnon}`;
}

/** "Спросить людей" when someone could be asked; otherwise the way out that works: the team of the club. */
async function askButton(db: D1Database, t: ThreadRow, m: Messages): Promise<InlineButton> {
  return (await askable(db, t.member_id)) ? btn(m.bAskPeople, `t:${t.id}:ask`) : btn(m.bTeam, `t:${t.id}:team`);
}

async function latestIntro(db: D1Database, needId: string): Promise<IntroRow | null> {
  return db.prepare("SELECT id, status, candidate_id, requester_id FROM intros WHERE need_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(needId).first<IntroRow>();
}

function quotesOf(json: string | null): Quote[] {
  try {
    return json ? (JSON.parse(json) as Quote[]) : [];
  } catch {
    return [];
  }
}

const OUTCOME_LABEL = (m: Messages, o: Outcome) => (o === "contact" ? m.outcomeContactLabel : o === "advice" ? m.outcomeAdviceLabel : m.outcomeSolvedLabel);
const OUTCOME_BUTTON = (m: Messages, o: Outcome) => (o === "contact" ? m.bOutcomeContact : o === "advice" ? m.bOutcomeAdvice : m.bOutcomeSolved);

/** The three-level "Итог" question (plan: journey 3, outcome). */
export const outcomeButtons = (m: Messages, id: string): InlineButton[][] => OUTCOMES.map((o) => [btn(OUTCOME_BUTTON(m, o), `t:${id}:o:${o}`)]);

/** The card as the asker should see it now. Null if the thread doesn't exist or has no card. */
export async function renderThread(db: D1Database, threadId: string, now = new Date()): Promise<Rendered | null> {
  const t = await db
    .prepare("SELECT t.*, m.lang AS lang FROM threads t JOIN members m ON m.id = t.member_id WHERE t.id=?")
    .bind(threadId)
    .first<ThreadRow & { lang: Lang | null }>();
  if (!t || t.message_id === null) return null;
  const lang = t.lang ?? defaultLang();
  const m = T(lang);
  const card = (text: string, buttons: InlineButton[][] = []): Rendered => ({ chatId: t.chat_id, messageId: t.message_id!, text, buttons });
  const id = t.id;

  if (t.outcome) {
    // A deal closes as solved; its proof is the confirmed deal (deals.ts), which is what the card names.
    const deal = await dealAgreed(db, id);
    const lines = [m.threadClosed(deal ? T2(lang).outcomeDealLabel : OUTCOME_LABEL(m, t.outcome))];
    const buttons = t.helper_id && !t.thanked_at ? [[btn(m.bThanks, `t:${id}:thx`)]] : [];
    if (t.thanked_at) lines.push(m.threadThanked);
    return card(lines.join("\n"), buttons);
  }
  if (t.state === "searching") return card(m.threadSearching);
  if (t.state === "memory") {
    const quotes = quotesOf(t.quotes_json);
    const names = await namesFor(db, quotes.map((q) => q.author_id ?? "").filter(Boolean));
    const lines = [`<b>${m.threadMemoryHead}</b>`];
    if (t.brief) lines.push(escapeHtml(t.brief), m.aiNote);
    for (const q of quotes) {
      const who = q.author_id ? personLabel(q.author_id, names.get(q.author_id), m) : m.memberAnon;
      const source = q.url ? ` · <a href="${escapeHtml(q.url)}">${m.source}</a>` : "";
      const doc = q.label ? ` · ${escapeHtml(q.label)}` : ""; // document passages carry their file and time
      lines.push(`\n${quoteHtml(escapeHtml(q.text))}${who} · ${monthLabel(q.event_at, t.lang ?? defaultLang())}${doc}${source}`);
    }
    const extra = await extrasFor(db, t, lang);
    lines.push(...extra.lines, `\n${m.threadMemoryAsk}`);
    return card(lines.join("\n"), [[btn(m.bThatsIt, `t:${id}:ok`), await askButton(db, t, m)], [btn(m.bNotThat, `t:${id}:no`)], ...extra.buttons]);
  }
  if (t.state === "closed") return card(t.brief ?? m.threadStopped); // brief carries a note here, e.g. "no access"
  if (t.bridge_id) {
    // The request went to a partner club (Мост): the card follows that, with the same buttons as people.
    const b = await db
      .prepare("SELECT b.status, b.outcome, s.title AS to_title FROM bridges b JOIN sources s ON s.id = b.to_source_id WHERE b.id=?")
      .bind(t.bridge_id)
      .first<{ status: string; outcome: string | null; to_title: string | null }>();
    const to = escapeHtml(b?.to_title ?? "");
    if (b?.status === "open") return card(m.threadBridgeOpen(to), [[btn(m.bCancelAsk, `t:${id}:cancel`)]]);
    if (b?.status === "helper_yes") return card(m.bridgeHelp(to), [[btn(m.bOpenContact, `bh:${t.bridge_id}:ask`)]]);
    if (b?.status === "connected") return card(m.threadBridgeConnected(to), [[btn(m.bHelpfulBridge, `bh:${t.bridge_id}:helpful`)]]);
    if (b?.status === "closed") return card(b.outcome === "helpful" ? m.threadBridgeClosed : m.threadBridgeEnded);
    if (b?.status === "expired") return card(m.threadBridgeExpired(to), [[btn(m.bAskPeople, `t:${id}:ask`)]]);
  }
  // asking / introduced
  if (!t.need_id) {
    const clubs = await db
      .prepare("SELECT 1 FROM alliances a WHERE a.status='active' AND (a.inviter_source_id IN (SELECT source_id FROM source_access WHERE member_id=? AND revoked_at IS NULL) OR a.partner_source_id IN (SELECT source_id FROM source_access WHERE member_id=? AND revoked_at IS NULL)) LIMIT 1")
      .bind(t.member_id, t.member_id)
      .first();
    const extra = await extrasFor(db, t, lang);
    return card([m.threadNothing, ...extra.lines].join("\n"), [[await askButton(db, t, m)], ...(clubs ? [[btn(m.bBridge, `t:${id}:bridge`)]] : []), ...extra.buttons]);
  }
  const need = await db.prepare("SELECT status FROM needs WHERE id=?").bind(t.need_id).first<{ status: string }>();
  const intro = await latestIntro(db, t.need_id);
  const asked = (await db.prepare("SELECT COUNT(*) AS n FROM intros WHERE need_id=?").bind(t.need_id).first<{ n: number }>())?.n ?? 0;
  if (intro?.status === "invited") return card(m.threadAsking(asked), [[btn(m.bCancelAsk, `t:${id}:cancel`)]]);
  if (intro?.status === "accepted") {
    const names = await namesFor(db, [intro.candidate_id]);
    return card(m.threadCandidate(personLabel(intro.candidate_id, names.get(intro.candidate_id), m)), [[btn(m.bConfirm, `i:${intro.id}:confirm`)], [btn(m.bCancel, `i:${intro.id}:cancel`)]]);
  }
  if (intro && CONNECTED.has(intro.status)) {
    const due = !!t.followup_at && t.followup_at <= nowIso(now);
    const lines = [due ? m.threadFollowup : m.threadConnected];
    const buttons: InlineButton[][] = due ? outcomeButtons(m, id) : [];
    if (kindOf(t.question) === "hiring") {
      // "We agreed on the work" counts only once the helper confirms it too (deals.ts).
      const deal = await dealStatus(db, intro.id);
      if (deal === "proposed") lines.push(T2(lang).dealWaiting);
      else {
        if (deal === "declined") lines.push(T2(lang).dealDeclined);
        buttons.push([btn(T2(lang).bDeal, `t:${id}:deal`)]);
      }
    }
    return card(lines.join("\n"), buttons);
  }
  // Nobody is on the hook right now: the search is over, or it is about to ask the next person.
  if (need?.status === "cancelled") return card(m.threadCancelled);
  if (need?.status === "expired") return card(m.threadExpired, [[await askButton(db, t, m)]]);
  if (need?.status === "no_match") return card(m.introClosedNoMatch, [[btn(m.bTeam, `t:${id}:team`)]]);
  if (need?.status === "waiting") return card(m.threadNoMatch, [[btn(m.bCancelAsk, `t:${id}:cancel`)], [btn(m.bTeam, `t:${id}:team`)]]);
  return card(m.threadAsking(asked), [[btn(m.bCancelAsk, `t:${id}:cancel`)]]);
}

/**
 * What a request's kind adds to its card: who here recommends the topic (quotes with their links,
 * from groups the asker can read), and, for someone looking for work, the open-to-projects switch.
 */
async function extrasFor(db: D1Database, t: ThreadRow, lang: Lang): Promise<{ lines: string[]; buttons: InlineButton[][] }> {
  const tt = T2(lang);
  const m = T(lang);
  const out: { lines: string[]; buttons: InlineButton[][] } = { lines: [], buttons: [] };
  if (kindOf(t.question) === "looking_for_work") {
    const me = await db.prepare("SELECT open_work FROM members WHERE id=?").bind(t.member_id).first<{ open_work: number }>();
    out.buttons.push([btn(me?.open_work ? tt.bOpenOff : tt.bOpenOn, `t:${t.id}:${me?.open_work ? "openoff" : "open"}`)]);
  }
  const asker = await memberById(db, t.member_id);
  if (asker) {
    const recs = await recommendationsFor(db, await readable(db, asker), asker.id, t.question);
    if (recs.length) {
      const names = await namesFor(db, recs.map((r) => r.author_id));
      out.lines.push("", `<b>${tt.recHead}</b>`);
      for (const r of recs) {
        const source = r.url ? ` · <a href="${escapeHtml(r.url)}">${m.source}</a>` : "";
        out.lines.push(`<blockquote>${escapeHtml(r.text)}</blockquote>${personLabel(r.author_id, names.get(r.author_id), m)} · ${monthLabel(r.event_at, lang)}${source}`);
      }
    }
  }
  return out;
}

/** The status of a proposed deal for an introduction, or null when nobody has proposed one. */
export async function dealStatus(db: D1Database, introId: string): Promise<string | null> {
  return (await db.prepare("SELECT status FROM deals WHERE intro_id=?").bind(introId).first<{ status: string }>())?.status ?? null;
}

/** Whether a thread's introduction ended in a deal that both sides confirmed. */
async function dealAgreed(db: D1Database, threadId: string): Promise<boolean> {
  return !!(await db
    .prepare("SELECT 1 FROM deals d JOIN intros i ON i.id = d.intro_id JOIN threads t ON t.need_id = i.need_id WHERE t.id = ? AND d.status = 'agreed' LIMIT 1")
    .bind(threadId)
    .first());
}

/** Apply a rendered card. "Not modified" just means the card already shows this. */
export async function applyCard(tg: Telegram, r: Rendered): Promise<void> {
  try {
    await tg.call("editMessageText", {
      chat_id: r.chatId,
      message_id: r.messageId,
      text: r.text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: r.buttons },
    });
  } catch (e) {
    if (String(e).includes("message is not modified")) return;
    throw e;
  }
}

/**
 * Queue a card edit for an introduction's request, after its state changed. Returns the effect key
 * to dispatch. The edit is rendered again when it is sent, so this only needs to be called once
 * per change. Threads that already closed, or never had a card, get nothing.
 */
export async function syncNeed(db: D1Database, needId: string, now = nowIso()): Promise<string[]> {
  const t = await db
    .prepare("SELECT id, state, chat_id, message_id, rev, followup_at, followup_sent_at FROM threads WHERE need_id=? AND outcome IS NULL")
    .bind(needId)
    .first<Pick<ThreadRow, "id" | "state" | "chat_id" | "message_id" | "rev" | "followup_at" | "followup_sent_at">>();
  if (!t || t.message_id === null) return [];
  const intro = await latestIntro(db, needId);
  const state: ThreadState = intro && (intro.status === "accepted" || CONNECTED.has(intro.status)) ? "introduced" : "asking";
  // The follow-up clock starts once contacts are open, and only once (followup_sent_at marks the send).
  const followupAt = intro && CONNECTED.has(intro.status) && !t.followup_at && !t.followup_sent_at ? addMs(now, FOLLOWUP_AFTER) : t.followup_at;
  const rev = t.rev + 1;
  const key = `thread:${t.id}:${rev}`;
  const stmts = [
    db.prepare("UPDATE threads SET state=?, rev=?, followup_at=?, updated_at=? WHERE id=?").bind(state, rev, followupAt, now, t.id),
    db.prepare("INSERT INTO thread_events(thread_id, state, at) SELECT ?, ?, ? WHERE ? <> ?").bind(t.id, state, now, state, t.state),
    db
      .prepare("INSERT OR IGNORE INTO effects(id, key, chat_id, payload, state, created_at, updated_at) VALUES (?,?,?,?, 'pending', ?, ?)")
      .bind(crypto.randomUUID(), key, t.chat_id, JSON.stringify({ thread: t.id, edit: t.message_id }), now, now),
  ];
  await db.batch(stmts);
  return [key];
}

/** The people behind a helper's thank-you: how many people they've helped so far. */
export async function helpedCount(db: D1Database, memberId: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM intros WHERE candidate_id=? AND outcome='helpful'").bind(memberId).first<{ n: number }>())?.n ?? 0;
}

/** Queue a card edit for the thread following a bridge, after the bridge changed. */
export async function bridgeCardKeys(db: D1Database, bridgeId: string, now = nowIso()): Promise<string[]> {
  const t = await db
    .prepare("SELECT id, chat_id, message_id, rev FROM threads WHERE bridge_id=? AND outcome IS NULL AND message_id IS NOT NULL")
    .bind(bridgeId)
    .first<{ id: string; chat_id: number; message_id: number; rev: number }>();
  if (!t) return [];
  const rev = t.rev + 1;
  const key = `thread:${t.id}:${rev}`;
  await db.batch([
    db.prepare("UPDATE threads SET rev=?, updated_at=? WHERE id=?").bind(rev, now, t.id),
    db
      .prepare("INSERT OR IGNORE INTO effects(id, key, chat_id, payload, state, created_at, updated_at) VALUES (?,?,?,?, 'pending', ?, ?)")
      .bind(crypto.randomUUID(), key, t.chat_id, JSON.stringify({ thread: t.id, edit: t.message_id }), now, now),
  ]);
  return [key];
}
