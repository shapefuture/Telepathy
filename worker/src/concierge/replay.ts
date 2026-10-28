// History replay (ADR-007): before the concierge acts for anyone, run it over past requests and
// compare what it would have done with what really happened. It only sees what existed before each
// request (search and conversations are cut off at the request's time), and keeps no names: routing
// is scored as "someone who really replied was among the people it would ask".

import type { App } from "../bot";
import { matchSkills } from "../experts";
import type { Lang } from "../i18n";
import { effectStatement } from "../outbox";
import type { InlineButton } from "../telegram";
import { DAY, nowIso } from "../util";
import { decide, PROMPT_VERSION } from "./agent";
import { conversationsFor } from "./context";
import { stats } from "./gate";
import { effectiveLevel, parseAutonomy, type Action, type ReviewStats } from "./policy";

/** Cases per cron run: each is one model call and a handful of reads. */
export const PER_RUN = 2;
export const QUEUE_MAX = 200;
/** People the routing would ask, and how far back it looks for who helped before. */
export const CANDIDATES = 3;
export const HISTORY_REPLIES = 200;
/** Generated text is kept this long for review, then only the numbers and verdicts remain. */
export const TEXT_DAYS = 30;

const QUEUE_KEY = "concierge.queue";
const HELP = "p.intent='help_request' AND p.intent_conf>=0.55 AND p.part=0 AND p.removed_at IS NULL AND p.body IS NOT NULL";

interface Request {
  id: number;
  source_id: string;
  msg_id: number;
  author_id: string | null;
  body: string;
  event_at: string;
}

/** Past requests in these groups that this prompt version hasn't replayed yet, newest first. */
export async function pendingRequests(db: D1Database, sources: string[], limit: number): Promise<Request[]> {
  if (!sources.length || limit <= 0) return [];
  return (
    await db
      .prepare(
        `SELECT p.id, p.source_id, p.msg_id, p.author_id, p.body, p.event_at FROM passages p JOIN sources s ON s.id = p.source_id AND s.enabled = 1
         WHERE ${HELP} AND p.source_id IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM concierge_cases c WHERE c.subject = 'p:' || p.id AND c.version = ?)
         ORDER BY p.event_at DESC LIMIT ?`,
      )
      .bind(JSON.stringify(sources), PROMPT_VERSION, limit)
      .all<Request>()
  ).results;
}

/** Who answered questions on these topics in this group before the request (requester excluded). */
export async function earlierHelpers(db: D1Database, r: Request, codes: string[]): Promise<string[]> {
  if (!codes.length) return [];
  const { results } = await db
    .prepare(
      `SELECT author_id, body FROM passages WHERE source_id = ? AND reply_to IS NOT NULL AND part = 0 AND removed_at IS NULL AND body IS NOT NULL
         AND author_id IS NOT NULL AND author_id != IFNULL(?, '') AND event_at < ?
         AND author_id NOT IN (SELECT id FROM members WHERE collection_opt_out = 1 OR removed_at IS NOT NULL)
       ORDER BY event_at DESC LIMIT ?`,
    )
    .bind(r.source_id, r.author_id, r.event_at, HISTORY_REPLIES)
    .all<{ author_id: string; body: string }>();
  const counts = new Map<string, number>();
  for (const row of results) if (matchSkills(row.body, 3).some((c) => codes.includes(c))) counts.set(row.author_id, (counts.get(row.author_id) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, CANDIDATES)
    .map(([id]) => id);
}

/** What really happened: who replied to the request (not the asker), and how soon. */
export async function reality(db: D1Database, r: Request): Promise<{ repliers: Set<string>; minutes: number | null }> {
  const { results } = await db
    .prepare(
      "SELECT author_id, event_at FROM passages WHERE source_id = ? AND reply_to = ? AND part = 0 AND removed_at IS NULL AND author_id IS NOT NULL AND author_id != IFNULL(?, '') ORDER BY event_at LIMIT 10",
    )
    .bind(r.source_id, r.msg_id, r.author_id)
    .all<{ author_id: string; event_at: string }>();
  const first = results[0];
  return { repliers: new Set(results.map((x) => x.author_id)), minutes: first ? Math.max(0, Math.round((Date.parse(first.event_at) - Date.parse(r.event_at)) / 60_000)) : null };
}

/** Replay one past request and store the case. */
export async function replayOne(app: App, r: Request, lang: Lang, now = new Date()): Promise<void> {
  const { convs, found } = await conversationsFor(app.db, new Set([r.source_id]), r.body, r.event_at);
  const plan = await decide(app, r.body, convs, lang);
  const asked = plan.action === "ask_people" ? await earlierHelpers(app.db, r, plan.codes) : [];
  const real = await reality(app.db, r);
  const hit = real.repliers.size ? (asked.some((id) => real.repliers.has(id)) ? 1 : 0) : null;
  await app.db
    .prepare(
      `INSERT INTO concierge_cases(subject, mode, source_id, version, created_at, model, action, error, downgraded, brief, answer, question,
         quotes_verified, quotes_failed, evidence, codes, candidates, helper_hit, real_replied, real_minutes, executed)
       VALUES (?, 'replay', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(subject, version) DO NOTHING`,
    )
    .bind(
      `p:${r.id}`,
      r.source_id,
      PROMPT_VERSION,
      nowIso(now),
      plan.model,
      plan.action,
      plan.error ?? null,
      plan.downgraded ? 1 : 0,
      plan.brief,
      plan.answer,
      plan.question,
      plan.verified,
      plan.failed,
      found,
      JSON.stringify(plan.codes),
      asked.length,
      plan.action === "ask_people" ? hit : null,
      real.repliers.size ? 1 : 0,
      real.minutes,
    )
    .run();
}

// ---- the queue, worked by the cron ------------------------------------------------------

interface Queue {
  left: number;
  sources: string[];
  by: number;
  lang: Lang;
}

export async function queueRun(db: D1Database, sources: string[], n: number, byTg: number, lang: Lang): Promise<number> {
  const left = Math.max(1, Math.min(QUEUE_MAX, Math.floor(n) || 0));
  const q: Queue = { left, sources, by: byTg, lang };
  await db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(QUEUE_KEY, JSON.stringify(q)).run();
  return left;
}

export async function queued(db: D1Database): Promise<Queue | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key=?").bind(QUEUE_KEY).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as Queue) : null;
}

/** Cron step: a couple of cases per run; tells the operator when the run is done. */
export async function replayStep(app: App, now = new Date()): Promise<number> {
  const q = await queued(app.db);
  if (!q) return 0;
  if (app.budget && app.budget.left() < 6) return 0;
  const want = Math.min(PER_RUN, q.left);
  const todo = await pendingRequests(app.db, q.sources, want);
  for (const r of todo) {
    try {
      await replayOne(app, r, q.lang, now);
    } catch (e) {
      // Record it as failed so one bad request can't stall the queue every minute.
      console.error("concierge replay failed", r.id, String(e));
      await app.db
        .prepare("INSERT INTO concierge_cases(subject, mode, source_id, version, created_at, error, executed) VALUES (?, 'replay', ?, ?, ?, 'replay_failed', 1) ON CONFLICT(subject, version) DO NOTHING")
        .bind(`p:${r.id}`, r.source_id, PROMPT_VERSION, nowIso(now))
        .run();
    }
  }
  const left = q.left - todo.length;
  if (left > 0 && todo.length === want) {
    await app.db.prepare("UPDATE settings SET value=? WHERE key=?").bind(JSON.stringify({ ...q, left }), QUEUE_KEY).run();
    return todo.length;
  }
  const m = C(q.lang);
  await app.db.batch([
    app.db.prepare("DELETE FROM settings WHERE key=?").bind(QUEUE_KEY),
    effectStatement(app.db, `concierge:done:${nowIso(now)}:${q.by}`, q.by, { text: m.done, buttons: [[{ text: m.bReport, callback_data: "cg:rep" }]] }),
  ]);
  return todo.length;
}

// ---- deletion and age ------------------------------------------------------------------

/** Drops all generated text (it can quote anyone); numbers and verdicts stay. Like ai_cache. */
export const scrubStatement = (db: D1Database): D1PreparedStatement =>
  db.prepare("UPDATE concierge_cases SET brief=NULL, answer=NULL, question=NULL WHERE brief IS NOT NULL OR answer IS NOT NULL OR question IS NOT NULL");

export async function pruneText(db: D1Database, now = new Date()): Promise<number> {
  const cut = nowIso(new Date(now.getTime() - TEXT_DAYS * DAY));
  const r = await db
    .prepare("UPDATE concierge_cases SET brief=NULL, answer=NULL, question=NULL WHERE created_at < ? AND (brief IS NOT NULL OR answer IS NOT NULL OR question IS NOT NULL)")
    .bind(cut)
    .run();
  return r.meta.changes ?? 0;
}

// ---- report and review -----------------------------------------------------------------

export interface Report {
  cases: number;
  failed: number;
  byAction: Record<string, number>;
  realUnanswered: number;
  /** Nobody really replied, and the concierge had a checked answer or people to ask. */
  couldHelp: number;
  /** ask_people cases where someone really replied: how often that person was among those asked. */
  routed: number;
  hits: number;
  reviews: Partial<Record<Action, ReviewStats>>;
}

const REPORT_ACTIONS: Action[] = ["answer", "ask_people", "clarify", "escalate"];

/** Replay numbers (the report counts replayed requests only); reviews come from the gate, all modes. */
export async function report(db: D1Database, sources: string[]): Promise<Report> {
  const src = JSON.stringify(sources);
  const [totals, actions] = await db.batch([
    db
      .prepare(
        `SELECT COUNT(*) AS cases, SUM(action IS NULL) AS failed, SUM(real_replied = 0) AS unanswered,
                SUM(real_replied = 0 AND ((action = 'answer' AND quotes_verified > 0) OR (action = 'ask_people' AND candidates > 0))) AS could,
                SUM(helper_hit IS NOT NULL) AS routed, SUM(helper_hit = 1) AS hits
         FROM concierge_cases WHERE mode = 'replay' AND version = ? AND source_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(PROMPT_VERSION, src),
    db
      .prepare("SELECT action, COUNT(*) AS n FROM concierge_cases WHERE mode = 'replay' AND version = ? AND action IS NOT NULL AND source_id IN (SELECT value FROM json_each(?)) GROUP BY action")
      .bind(PROMPT_VERSION, src),
  ]);
  const t = (totals!.results[0] ?? {}) as Record<string, number | null>;
  const reviews: Partial<Record<Action, ReviewStats>> = {};
  for (const a of REPORT_ACTIONS) reviews[a] = await stats(db, a);
  return {
    cases: t.cases ?? 0,
    failed: t.failed ?? 0,
    byAction: Object.fromEntries((actions!.results as { action: string; n: number }[]).map((r) => [r.action, r.n])),
    realUnanswered: t.unanswered ?? 0,
    couldHelp: t.could ?? 0,
    routed: t.routed ?? 0,
    hits: t.hits ?? 0,
    reviews,
  };
}

export interface ReviewCase {
  id: number;
  action: string;
  brief: string | null;
  answer: string | null;
  question: string | null;
  candidates: number;
  helper_hit: number | null;
  real_replied: number;
  real_minutes: number | null;
  event_at: string;
  body: string;
}

/** The next replayed case to judge: text still kept, the request not deleted, in a group the reviewer reads. */
export async function nextForReview(db: D1Database, sources: string[]): Promise<ReviewCase | null> {
  return db
    .prepare(
      `SELECT c.id, c.action, c.brief, c.answer, c.question, c.candidates, c.helper_hit, c.real_replied, c.real_minutes, p.event_at, p.body
       FROM concierge_cases c JOIN passages p ON 'p:' || p.id = c.subject AND p.removed_at IS NULL AND p.body IS NOT NULL
       WHERE c.mode = 'replay' AND c.version = ? AND c.verdict IS NULL AND c.action IS NOT NULL AND c.brief IS NOT NULL AND c.source_id IN (SELECT value FROM json_each(?))
       ORDER BY c.id LIMIT 1`,
    )
    .bind(PROMPT_VERSION, JSON.stringify(sources))
    .first<ReviewCase>();
}

export async function review(db: D1Database, id: number, verdict: "good" | "bad" | "skip", sources: string[], now = new Date()): Promise<boolean> {
  const r = await db
    .prepare("UPDATE concierge_cases SET verdict=?, reviewed_at=? WHERE id=? AND verdict IS NULL AND source_id IN (SELECT value FROM json_each(?))")
    .bind(verdict, nowIso(now), id, JSON.stringify(sources))
    .run();
  return (r.meta.changes ?? 0) > 0;
}

// ---- texts (EN/RU; RU typed against EN) -------------------------------------------------

const EN = {
  head: "<b>Concierge: history replay</b>",
  intro:
    "I go through past requests in your groups, decide what I would have done using only what was written before each one, and compare with what really happened. Nobody is messaged.",
  none: "No replayed requests yet. Press «Replay 20» and I'll go through them, two a minute.",
  queued: (n: number) => `Queued: up to ${n} past requests. I'll write when they're done.`,
  running: (n: number) => `Replay in progress: ${n} left.`,
  noGroups: "You can't read any connected group yet, so there's nothing to replay.",
  aiOff: "The concierge model is off (CONCIERGE_MODEL=off or no AI binding). Replay would record only routing.",
  done: "Concierge replay finished.",
  cases: (n: number, failed: number) => `Requests replayed: <b>${n}</b>${failed ? ` (no usable decision: ${failed})` : ""}`,
  actions: "What I would have done:",
  action: { answer: "answer from memory", ask_people: "ask people who know", clarify: "ask a clarifying question", escalate: "hand to the club's team" } as Record<string, string>,
  unanswered: (n: number, could: number) => `Really left without a reply: <b>${n}</b>; of those I'd have had a checked answer or people to ask: <b>${could}</b>`,
  hits: (hits: number, routed: number) => `When I'd ask people and someone really replied, that person was among mine: <b>${hits} of ${routed}</b>`,
  autonomy: "Autonomy (your setting, capped by code and by your reviews):",
  level: { off: "off", suggest: "with approval", auto: "on its own" } as Record<string, string>,
  reviewed: (r: ReviewStats) => `${r.good}/${r.reviewed} judged right`,
  bRun: "▶️ Replay 20",
  bReview: "📝 Review",
  bReport: "📊 Report",
  reviewHead: "<b>Would this have been right?</b>",
  asked: (when: string) => `Request (${when}):`,
  reality: (replied: number, minutes: number | null) => (replied ? `Really: someone replied${minutes != null ? ` after ${fmtMinutes(minutes, "en")}` : ""}.` : "Really: nobody replied."),
  mine: "I would have:",
  people: (n: number, hit: number | null) => (n ? `asked ${n} ${n === 1 ? "person" : "people"} who answered similar questions${hit === 1 ? ", including someone who really replied" : ""}` : "found nobody to ask yet"),
  bGood: "✅ Right",
  bBad: "❌ Wrong",
  bSkip: "⏭ Skip",
  allReviewed: "Nothing left to review. Replay more or come back after the next run.",
};
type Texts = typeof EN;
const RU: Texts = {
  head: "<b>Консьерж: проверка на истории</b>",
  intro:
    "Я прохожу по прошлым запросам в ваших группах, решаю, что сделал бы, зная только написанное до каждого, и сравниваю с тем, что было на самом деле. Никому ничего не пишу.",
  none: "Пока нет проверенных запросов. Нажмите «Проверить 20» — пройду по ним, по два в минуту.",
  queued: (n: number) => `В очереди до ${n} прошлых запросов. Напишу, когда закончу.`,
  running: (n: number) => `Идёт проверка: осталось ${n}.`,
  noGroups: "Вы пока не читаете ни одну подключённую группу, проверять нечего.",
  aiOff: "Модель консьержа выключена (CONCIERGE_MODEL=off или нет привязки AI). Проверка запишет только подбор людей.",
  done: "Проверка консьержа на истории закончена.",
  cases: (n: number, failed: number) => `Проверено запросов: <b>${n}</b>${failed ? ` (без решения: ${failed})` : ""}`,
  actions: "Что я сделал бы:",
  action: { answer: "ответ из памяти", ask_people: "спросить знающих", clarify: "уточнить запрос", escalate: "передать команде клуба" },
  unanswered: (n: number, could: number) => `На самом деле остались без ответа: <b>${n}</b>; из них у меня был проверенный ответ или люди, которых спросить: <b>${could}</b>`,
  hits: (hits: number, routed: number) => `Когда я спросил бы людей, а кто-то действительно ответил, этот человек был среди моих: <b>${hits} из ${routed}</b>`,
  autonomy: "Самостоятельность (ваша настройка, ограниченная кодом и вашими оценками):",
  level: { off: "выключено", suggest: "с одобрения", auto: "сам" },
  reviewed: (r: ReviewStats) => `${r.good}/${r.reviewed} оценены как верные`,
  bRun: "▶️ Проверить 20",
  bReview: "📝 Оценить",
  bReport: "📊 Итоги",
  reviewHead: "<b>Так было бы правильно?</b>",
  asked: (when: string) => `Запрос (${when}):`,
  reality: (replied: number, minutes: number | null) => (replied ? `На самом деле: ответили${minutes != null ? ` через ${fmtMinutes(minutes, "ru")}` : ""}.` : "На самом деле: никто не ответил."),
  mine: "Я бы:",
  people: (n: number, hit: number | null) => (n ? `спросил ${n} ${n === 1 ? "человека" : "человек"}, отвечавших на похожее${hit === 1 ? ", среди них — тот, кто действительно ответил" : ""}` : "пока не нашёл, кого спросить"),
  bGood: "✅ Верно",
  bBad: "❌ Неверно",
  bSkip: "⏭ Пропустить",
  allReviewed: "Оценивать больше нечего. Запустите ещё проверку или загляните после неё.",
};
export const C = (lang: Lang): Texts => (lang === "ru" ? RU : EN);

function fmtMinutes(m: number, lang: Lang): string {
  if (m < 60) return lang === "ru" ? `${m} мин` : `${m} min`;
  if (m < 48 * 60) return lang === "ru" ? `${Math.round(m / 60)} ч` : `${Math.round(m / 60)} h`;
  return lang === "ru" ? `${Math.round(m / 1440)} дн` : `${Math.round(m / 1440)} d`;
}

const btn = (text: string, data: string): InlineButton => ({ text, callback_data: data });

export function reportView(r: Report, lang: Lang, autonomyRaw: string | undefined, running: number | null, aiOn: boolean): { text: string; buttons: InlineButton[][] } {
  const m = C(lang);
  const lines = [m.head, m.intro, ""];
  if (!aiOn) lines.push(m.aiOff, "");
  if (running) lines.push(m.running(running), "");
  if (!r.cases) lines.push(m.none);
  else {
    lines.push(m.cases(r.cases, r.failed), "", m.actions);
    for (const a of ["answer", "ask_people", "clarify", "escalate"]) if (r.byAction[a]) lines.push(`• ${m.action[a]}: ${r.byAction[a]}`);
    lines.push("", m.unanswered(r.realUnanswered, r.couldHelp));
    if (r.routed) lines.push(m.hits(r.hits, r.routed));
  }
  const configured = parseAutonomy(autonomyRaw);
  lines.push("", m.autonomy);
  for (const a of ["clarify", "answer", "ask_people", "escalate"] as Action[]) {
    const s = r.reviews[a];
    lines.push(`• ${m.action[a]}: ${m.level[effectiveLevel(a, configured, s)]}${s?.reviewed ? ` · ${m.reviewed(s)}` : ""}`);
  }
  return { text: lines.join("\n"), buttons: [[btn(m.bRun, "cg:run"), btn(m.bReview, "cg:rev")]] };
}

export function reviewView(c: ReviewCase | null, lang: Lang, escape: (s: string) => string, snip: (s: string) => string): { text: string; buttons: InlineButton[][] } {
  const m = C(lang);
  if (!c) return { text: m.allReviewed, buttons: [[btn(m.bRun, "cg:run"), btn(m.bReport, "cg:rep")]] };
  const what =
    c.action === "answer"
      ? `${m.action.answer}: ${escape(c.answer ?? "")}`
      : c.action === "clarify"
        ? `${m.action.clarify}: «${escape(c.question ?? "")}»`
        : c.action === "ask_people"
          ? m.people(c.candidates, c.helper_hit)
          : m.action.escalate!;
  return {
    text: [m.reviewHead, "", m.asked(c.event_at.slice(0, 10)), `<i>${escape(snip(c.body))}</i>`, "", m.reality(c.real_replied, c.real_minutes), "", m.mine, `<b>${escape(c.brief ?? "")}</b>`, what].join("\n"),
    buttons: [[btn(m.bGood, `cg:ok:${c.id}`), btn(m.bBad, `cg:bad:${c.id}`), btn(m.bSkip, `cg:skip:${c.id}`)], [btn(m.bReport, "cg:rep")]],
  };
}
