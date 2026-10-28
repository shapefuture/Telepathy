// The jobs people bring to a club (plan: the census, «Кого здесь советуют», hiring, introductions).
// A request is labelled from its own words, a recommendation from a reply's words, and every number
// is counted from what the group already stores. Deterministic: no model is involved, and nothing is
// named unless the person opted in. Read-only, so a count can't change what a member sees.

import { matchSkills } from "../experts";
import { citation } from "../links";
import type { Lang } from "../i18n";
import { normalize, snippet } from "../text";
import { DAY, HOUR, nowIso } from "../util";
import { T2 } from "./texts";

export const JOB_KINDS = ["introduction", "partner", "looking_for_work", "hiring", "recommendation", "question"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Folded for matching: lower case, and е for ё, so one spelling of each word is enough. */
const fold = (s: string): string => normalize(s).replace(/ё/g, "е");

// Stems and phrases, so inflected forms match ("исполнителя", "исполнителей"). The first rule that
// matches wins; a request that matches none is a plain question.
const RULES: [Exclude<JobKind, "question">, RegExp][] = [
  ["introduction", /познаком|выйти на|выход на|выхода на|introduc|intro (to|for)|connect me (with|to)|get in touch with|контакт (директора|руководител|владельц)/],
  ["partner", /ищу (партнер|инвестор|соинвестор)|инвестор|investor|co-?founder|looking for (a )?partner/],
  ["looking_for_work", /ищу (работу|проекты|заказы|клиентов|подработк)|открыт[аоы]? к (проектам|заказам)|looking for (work|clients|projects|a job|freelance)/],
  [
    "hiring",
    /ищу (исполнител|разработчик|дизайнер|специалист|сотрудник|подрядчик|фрилансер|программист|копирайтер|маркетолог|бухгалтер|юрист|адвокат|переводчик|архитектор)|ищем (сотрудник|исполнител|подрядчик)|нужен (исполнител|разработчик|дизайнер|специалист|сотрудник|подрядчик|фрилансер|бухгалтер|юрист)|hiring|looking for (a |an )?(developer|designer|freelancer|contractor|engineer|writer|accountant|lawyer)|need (a |an )?(developer|designer|freelancer|contractor)/,
  ],
  [
    "recommendation",
    /посовет\S*(?! (как|что|почему|зачем|стоит|нужно|делать|лучше))|порекоменд\S*|рекоменд(уйте|уете|ации)|кого (порекомендуете|посоветуете)|кто (знает|может|подскажет|порекомендует) (хорош|проверенн|нормальн|надежн|толков)|подскаж\S* (хорош|проверенн|нормальн|надежн|толков)|any recommend|can (anyone|someone) recommend|does anyone know (a |an )?(good|reliable|trusted|decent)|who (do you|would you) recommend|recommend (a|an|some|good)/,
  ],
];

/** The kind of a request, from its words. A request with no rule matched is a plain question. */
export function kindOf(text: string): JobKind {
  const t = fold(text);
  for (const [kind, rx] of RULES) if (rx.test(t)) return kind;
  return "question";
}

/** A reply that points at a person or a service: «советую», «обращайтесь», «я работаю с…». */
const RECOMMENDING = /советую|рекоменд|обращайтес|обращал|обратил|работаю с|работал[аи]? с|пользуюсь|пользовал|ходил|ходила|i recommend|i'd recommend|highly recommend|worked with|go to |check out|can recommend/;
export const recommends = (text: string): boolean => RECOMMENDING.test(fold(text));

/** Short messages that bump a question or thank for an answer. Only the bare words count. */
const BUMP = /^(ап|апп|up|bump|поднимаю|актуально|↑)$/;
const THANKS = /^(спасибо|благодарю|спс|thanks|thank you|thx|ty)$/;
const bare = (text: string): string => fold(text).replace(/[^\p{L}\p{N}↑]+/gu, " ").trim();

export const REC_MAX = 3;
const REC_SCAN = 400;
export const CENSUS_DAYS = 180;
const CENSUS_REQUESTS = 4000;
const CENSUS_LINKS = 20_000;
const REPEAT_MS = 60 * DAY;
const BUMP_MS = 14 * DAY;
const THANKS_MS = 48 * HOUR;
export const NEWCOMER_DAYS = 30;
export const NEWCOMER_MIN = 3;

export interface Recommendation {
  text: string;
  event_at: string;
  author_id: string;
  url: string | null;
}

/**
 * «Кого здесь советуют»: replies in groups the asker can read that point at a person or a service
 * for the same topic. Quotes are verbatim, with the message's own link. Nothing is ranked by a model.
 */
export async function recommendationsFor(db: D1Database, readable: Set<string>, asker: string, question: string, limit = REC_MAX): Promise<Recommendation[]> {
  const codes = matchSkills(question, 3);
  if (!codes.length || !readable.size) return [];
  const { results } = await db
    .prepare(
      "SELECT r.body, r.event_at, r.author_id, r.msg_id, r.topic_id, s.chat_id, s.username FROM passages r JOIN sources s ON s.id = r.source_id " +
        "WHERE r.source_id IN (SELECT value FROM json_each(?)) AND r.reply_to IS NOT NULL AND r.part = 0 AND r.removed_at IS NULL " +
        "AND r.body IS NOT NULL AND r.author_id IS NOT NULL AND r.author_id != ? ORDER BY r.event_at DESC LIMIT ?",
    )
    .bind(JSON.stringify([...readable]), asker, REC_SCAN)
    .all<{ body: string; event_at: string; author_id: string; msg_id: number; topic_id: number | null; chat_id: number; username: string | null }>();
  const out: Recommendation[] = [];
  for (const r of results) {
    if (out.length >= limit) break;
    if (!recommends(r.body) || !matchSkills(r.body, 3).some((c) => codes.includes(c))) continue;
    out.push({ text: snippet(r.body, [], 240), event_at: r.event_at, author_id: r.author_id, url: citation(r.chat_id, r.msg_id, r.username, r.topic_id) });
  }
  return out;
}

export interface CensusRow {
  kind: JobKind;
  n: number;
  answered: number;
  medianMinutes: number | null;
  thanked: number;
  bumped: number;
  repeated: number;
}

export interface Census {
  total: number;
  rows: CensusRow[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * What the groups were asked, by kind, since `since`: how many were answered and how soon, how many
 * were thanked, bumped ("ап") or asked again on the same topic. Counted from stored messages only.
 */
export async function census(db: D1Database, sourceIds: string[], since: string): Promise<Census> {
  const rows = new Map<JobKind, CensusRow>(JOB_KINDS.map((k) => [k, { kind: k, n: 0, answered: 0, medianMinutes: null, thanked: 0, bumped: 0, repeated: 0 }]));
  const minutes = new Map<JobKind, number[]>(JOB_KINDS.map((k) => [k, []]));
  if (!sourceIds.length) return { total: 0, rows: [...rows.values()] };
  const ids = JSON.stringify(sourceIds);
  const { results: asks } = await db
    .prepare(
      "SELECT p.id, p.source_id, p.author_id, p.body, p.event_at FROM passages p WHERE p.source_id IN (SELECT value FROM json_each(?)) " +
        "AND p.part = 0 AND p.removed_at IS NULL AND p.body IS NOT NULL AND p.intent = 'help_request' AND p.intent_conf >= 0.55 AND p.event_at >= ? " +
        "ORDER BY p.event_at DESC LIMIT ?",
    )
    .bind(ids, since, CENSUS_REQUESTS)
    .all<{ id: number; source_id: string; author_id: string | null; body: string; event_at: string }>();
  asks.reverse();
  const { results: replies } = await db
    .prepare(
      "SELECT q.id AS qid, q.author_id AS asker, r.author_id AS replier, r.event_at AS at FROM passages q " +
        "JOIN passages r ON r.source_id = q.source_id AND r.reply_to = q.msg_id AND r.part = 0 AND r.removed_at IS NULL " +
        "WHERE q.source_id IN (SELECT value FROM json_each(?)) AND q.part = 0 AND q.removed_at IS NULL AND q.intent = 'help_request' " +
        "AND q.intent_conf >= 0.55 AND q.event_at >= ? ORDER BY r.event_at LIMIT ?",
    )
    .bind(ids, since, CENSUS_LINKS)
    .all<{ qid: number; asker: string | null; replier: string | null; at: string }>();
  const firstReply = new Map<number, { at: number }>();
  for (const r of replies) if (r.replier && r.replier !== r.asker && !firstReply.has(r.qid)) firstReply.set(r.qid, { at: Date.parse(r.at) });
  const { results: short } = await db
    .prepare(
      "SELECT source_id, author_id, event_at, body FROM passages WHERE source_id IN (SELECT value FROM json_each(?)) AND part = 0 " +
        "AND removed_at IS NULL AND body IS NOT NULL AND LENGTH(body) <= 60 AND author_id IS NOT NULL AND event_at >= ? ORDER BY event_at LIMIT ?",
    )
    .bind(ids, since, CENSUS_LINKS)
    .all<{ source_id: string; author_id: string; event_at: string; body: string }>();
  const said = new Map<string, { at: number; bump: boolean; thanks: boolean }[]>();
  for (const s of short) {
    const key = `${s.source_id}|${s.author_id}`;
    const b = bare(s.body);
    said.set(key, [...(said.get(key) ?? []), { at: Date.parse(s.event_at), bump: BUMP.test(b), thanks: THANKS.test(b) }]);
  }
  const askedAt = new Map<string, number[]>();
  for (const a of asks) {
    const kind = kindOf(a.body);
    const row = rows.get(kind)!;
    const at = Date.parse(a.event_at);
    const mine = said.get(`${a.source_id}|${a.author_id}`) ?? [];
    row.n += 1;
    const topic = matchSkills(a.body, 1)[0];
    if (topic) {
      const key = `${a.source_id}|${topic}`;
      const earlier = askedAt.get(key) ?? [];
      if (earlier.some((p) => at - p <= REPEAT_MS)) row.repeated += 1;
      askedAt.set(key, [...earlier, at]);
    }
    if (mine.some((m) => m.bump && m.at > at && m.at - at <= BUMP_MS)) row.bumped += 1;
    const first = firstReply.get(a.id);
    if (!first) continue;
    row.answered += 1;
    minutes.get(kind)!.push((first.at - at) / 60_000);
    if (mine.some((m) => m.thanks && m.at >= first.at && m.at - first.at <= THANKS_MS)) row.thanked += 1;
  }
  const total = asks.length;
  return {
    total,
    rows: JOB_KINDS.map((k) => ({ ...rows.get(k)!, medianMinutes: median(minutes.get(k)!) })),
  };
}

/** The share of requests that are about people (advice, hiring, introductions, partners). */
export function peopleShare(c: Census): number {
  const people = c.rows.filter((r) => r.kind !== "question" && r.kind !== "looking_for_work").reduce((a, r) => a + r.n, 0);
  return c.total ? Math.round((100 * people) / c.total) : 0;
}

/**
 * The weekly pulse's closing line: which requests were answered by kind, and how many introductions
 * connected or deals were agreed. A deal counts only when both sides confirmed it.
 */
export async function closedOf(db: D1Database, sourceId: string, since: string): Promise<{ answered: Record<JobKind, number>; connected: number; agreed: number }> {
  const c = await census(db, [sourceId], since);
  const answered = Object.fromEntries(c.rows.map((r) => [r.kind, r.answered])) as Record<JobKind, number>;
  const connected = (
    await db
      .prepare(
        "SELECT COUNT(DISTINCT t.id) AS n FROM threads t JOIN intros i ON i.need_id = t.need_id " +
          "WHERE t.source_id = ? AND i.status IN ('mutually_confirmed','completed') AND i.updated_at >= ?",
      )
      .bind(sourceId, since)
      .first<{ n: number }>()
  )?.n ?? 0;
  const agreed = (
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM deals d JOIN intros i ON i.id = d.intro_id JOIN threads t ON t.need_id = i.need_id " +
          "WHERE t.source_id = ? AND d.status = 'agreed' AND d.updated_at >= ?",
      )
      .bind(sourceId, since)
      .first<{ n: number }>()
  )?.n ?? 0;
  return { answered, connected, agreed };
}

/**
 * Newcomers: people new to the bot who have been talking in this group, and have had no useful
 * contact yet: no reply to any of their requests here, and no introduction at all.
 */
export async function newcomersOf(db: D1Database, sourceId: string, now: Date): Promise<string[]> {
  const since = nowIso(new Date(now.getTime() - NEWCOMER_DAYS * DAY));
  const { results } = await db
    .prepare(
      "SELECT m.id FROM members m WHERE m.created_at >= ? AND m.removed_at IS NULL AND m.collection_opt_out = 0 " +
        "AND EXISTS (SELECT 1 FROM passages p WHERE p.author_id = m.id AND p.source_id = ? AND p.part = 0 AND p.removed_at IS NULL AND p.event_at >= ?) " +
        "AND NOT EXISTS (SELECT 1 FROM passages q JOIN passages r ON r.source_id = q.source_id AND r.reply_to = q.msg_id AND r.part = 0 " +
        "  AND r.removed_at IS NULL AND r.author_id != q.author_id WHERE q.author_id = m.id AND q.source_id = ? AND q.part = 0 " +
        "  AND q.removed_at IS NULL AND q.intent = 'help_request') " +
        "AND NOT EXISTS (SELECT 1 FROM intros i WHERE i.requester_id = m.id OR i.candidate_id = m.id) LIMIT 200",
    )
    .bind(since, sourceId, since, sourceId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

const pct = (part: number, whole: number): string => `${whole ? Math.round((100 * part) / whole) : 0}%`;

function durationText(minutes: number | null, lang: Lang): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} ${lang === "ru" ? "мин" : "min"}`;
  return `${Math.round(minutes / 60)} ${lang === "ru" ? "ч" : "h"}`;
}

/** The census as the owner reads it: one line per kind, then the people share and a hint about introductions. */
export function censusView(c: Census, lang: Lang, doorsOn: boolean): string {
  const t = T2(lang);
  if (!c.total) return t.jobsNone;
  const lines = [t.jobsHead(c.total, CENSUS_DAYS)];
  for (const r of c.rows) {
    if (!r.n) continue;
    lines.push(t.jobsRow(t.jobKind[r.kind], r.n, pct(r.n - r.answered, r.n), durationText(r.medianMinutes, lang), pct(r.repeated, r.n)));
  }
  lines.push("", t.jobsPeople(peopleShare(c)));
  const intro = c.rows.find((r) => r.kind === "introduction")?.n ?? 0;
  if (!doorsOn && intro >= 5) lines.push(t.jobsIntroHint(intro));
  return lines.join("\n");
}

/** The census for the groups in scope, as text: the lines /jobs sends, and the Mini App's census card. */
export async function censusText(db: D1Database, sourceIds: string[], lang: Lang): Promise<string> {
  const c = await census(db, sourceIds, nowIso(new Date(Date.now() - CENSUS_DAYS * DAY)));
  const doors = await db
    .prepare("SELECT COUNT(*) AS n FROM sources WHERE doors=1 AND enabled=1 AND id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(sourceIds))
    .first<{ n: number }>();
  return censusView(c, lang, (doors?.n ?? 0) > 0);
}

/** The answered requests as one line: "Recommendations 3 · Questions 1", or "0". */
export function answeredText(answered: Record<JobKind, number>, lang: Lang): string {
  const t = T2(lang);
  return JOB_KINDS.filter((k) => answered[k] > 0).map((k) => `${t.jobKind[k]} ${answered[k]}`).join(" · ") || "0";
}

/** One group's closed numbers for a week, as the Monday pulse counted them. */
export interface Closed {
  answered: Record<JobKind, number>;
  connected: number;
  agreed: number;
}

/** Kept in settings, so the daily board can show the week without counting again. */
export async function storeClosed(db: D1Database, sourceId: string, week: string, c: Closed): Promise<void> {
  await db
    .prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(`closed.${sourceId}`, JSON.stringify({ week, ...c }))
    .run();
}

/**
 * The board's line: the closed numbers of the latest week any of these groups has, summed over them.
 * Null when nothing closed that week, or nothing has been stored yet.
 */
export async function closedSummary(db: D1Database, sourceIds: string[], lang: Lang): Promise<string | null> {
  if (!sourceIds.length) return null;
  const { results } = await db
    .prepare("SELECT value FROM settings WHERE key IN (SELECT 'closed.' || value FROM json_each(?))")
    .bind(JSON.stringify(sourceIds))
    .all<{ value: string }>();
  const rows = results.map((r) => JSON.parse(r.value) as Closed & { week: string });
  if (!rows.length) return null;
  const weeks = rows.map((r) => r.week).sort();
  const week = weeks[weeks.length - 1]!;
  const latest = rows.filter((r) => r.week === week);
  const answered = Object.fromEntries(JOB_KINDS.map((k) => [k, latest.reduce((a, r) => a + (r.answered[k] ?? 0), 0)])) as Record<JobKind, number>;
  const connected = latest.reduce((a, r) => a + r.connected, 0);
  const agreed = latest.reduce((a, r) => a + r.agreed, 0);
  if (!JOB_KINDS.some((k) => answered[k] > 0) && !connected && !agreed) return null;
  return T2(lang).boardClosed(week, answeredText(answered, lang), connected, agreed);
}
