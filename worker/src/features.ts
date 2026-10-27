// v2.1 features run from cron or commands: unanswered-question routing (P13-03), canonical answers
// (P13-07), private skill suggestions (P13-09) and the events list (P13-10). Every path stays
// inside the reader's own groups (C02) and only messages people who opted in.

import { langOf, readableSets, type Member } from "./acl";
import { classify } from "./classify";
import { eligibleCandidates, labelIn, labelsFor, matchSkills, TAXONOMY } from "./experts";
import { defaultLang, T, type Lang } from "./i18n";
import { citation } from "./ingest";
import { effectStatement } from "./outbox";
import { search } from "./search";
import { contentTerms, escapeHtml, normalize, snippet, termPresent } from "./text";
import { DAY, HOUR, nowIso } from "./util";

// ---- P13-03 unanswered-question routing ------------------------------------------------------

export const ROUTE_AFTER = 4 * HOUR;
export const ROUTE_MAX_AGE = DAY;
export const ROUTE_PER_QUESTION = 2;
export const ROUTE_PER_EXPERT_DAY = 3;

interface OpenQuestion {
  id: number;
  source_id: string;
  msg_id: number;
  body: string;
  author_id: string | null;
  topic_id: number | null;
  chat_id: number;
  username: string | null;
}

/** Cron step: ping up to 2 opted-in experts about questions unanswered for 4h. Returns effect keys. */
export async function routeUnanswered(db: D1Database, now = new Date()): Promise<string[]> {
  const { results: qs } = await db
    .prepare(
      "SELECT p.id, p.source_id, p.msg_id, p.body, p.author_id, p.topic_id, s.chat_id, s.username FROM passages p " +
        "JOIN sources s ON s.id = p.source_id AND s.enabled = 1 AND s.routing = 1 " +
        "WHERE p.part = 0 AND p.removed_at IS NULL AND p.intent = 'help_request' AND p.intent_conf >= 0.7 " +
        "AND p.event_at <= ? AND p.event_at >= ? " +
        "AND NOT EXISTS (SELECT 1 FROM passages r WHERE r.source_id = p.source_id AND r.reply_to = p.msg_id AND r.removed_at IS NULL) " +
        // A key range (not LIKE) so the lookup uses the key index.
        "AND NOT EXISTS (SELECT 1 FROM effects e WHERE e.key >= 'route:' || p.source_id || ':' || p.msg_id || ':' AND e.key < 'route:' || p.source_id || ':' || p.msg_id || ';') " +
        "ORDER BY p.event_at LIMIT 10",
    )
    .bind(nowIso(new Date(now.getTime() - ROUTE_AFTER)), nowIso(new Date(now.getTime() - ROUTE_MAX_AGE)))
    .all<OpenQuestion>();
  const keys: string[] = [];
  const dayAgo = nowIso(new Date(now.getTime() - DAY));
  for (const q of qs) {
    const codes = matchSkills(q.body);
    const stmts: D1PreparedStatement[] = [];
    if (codes.length) {
      const cands = await eligibleCandidates(db, q.author_id ?? "-", codes, nowIso(now));
      const ids = cands.map((c) => c.member_id);
      const { results: members } = ids.length
        ? await db.prepare("SELECT * FROM members WHERE id IN (SELECT value FROM json_each(?)) AND routing = 1").bind(JSON.stringify(ids)).all<Member>()
        : { results: [] as Member[] };
      const sets = await readableSets(db, members);
      const order = new Map(ids.map((id, i) => [id, i]));
      const ok = members.filter((m) => sets.get(m.id)?.has(q.source_id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      for (const m of ok) {
        if (stmts.length >= ROUTE_PER_QUESTION) break;
        const sent = await db
          .prepare("SELECT COUNT(*) AS n FROM effects WHERE key LIKE 'route:%' AND chat_id = ? AND created_at >= ?")
          .bind(m.tg_id, dayAgo)
          .first<{ n: number }>();
        if ((sent?.n ?? 0) >= ROUTE_PER_EXPERT_DAY) continue;
        const t = T(langOf(m));
        const url = citation(q.chat_id, q.msg_id, q.username, q.topic_id);
        const key = `route:${q.source_id}:${q.msg_id}:${m.id}`;
        stmts.push(
          effectStatement(db, key, m.tg_id, {
            text: t.routePing(escapeHtml(labelsFor(codes, langOf(m))), escapeHtml(snippet(q.body, [], 200)), url ? `<a href="${escapeHtml(url)}">${t.openQuestion}</a>` : ""),
          }),
        );
        keys.push(key);
      }
    }
    // Mark the question handled even when nobody matched, so it isn't re-scanned every run.
    stmts.push(
      db
        .prepare("INSERT OR IGNORE INTO effects(id, key, chat_id, payload, state, created_at, updated_at) VALUES (?,?,?,'{}','skipped',?,?)")
        .bind(crypto.randomUUID(), `route:${q.source_id}:${q.msg_id}:-`, 0, nowIso(now), nowIso(now)),
    );
    await db.batch(stmts);
  }
  return keys;
}

// ---- P13-07 canonical answers -----------------------------------------------------------------

/** Mark a message canonical; older canonical answers on the same topic in that group become outdated. */
export async function markCanonical(db: D1Database, sourceId: string, msgId: number): Promise<{ ok: boolean; superseded: number }> {
  const p = await db
    .prepare("SELECT id, body FROM passages WHERE source_id=? AND msg_id=? AND part=0 AND removed_at IS NULL AND body IS NOT NULL")
    .bind(sourceId, msgId)
    .first<{ id: number; body: string }>();
  if (!p) return { ok: false, superseded: 0 };
  const terms = contentTerms(p.body);
  const { hits } = await search(db, new Set([sourceId]), p.body);
  // Same topic = at least half the terms overlap, measured from either side (answers differ in length).
  const overlap = (a: string[], body: string) => a.filter((t) => termPresent(t, normalize(body))).length / Math.max(1, a.length);
  const older = hits.filter((h) => h.id !== p.id && h.canonical && Math.max(overlap(terms, h.body), overlap(contentTerms(h.body), p.body)) >= 0.5);
  await db.batch([
    db.prepare("UPDATE passages SET canonical=1, superseded_by=NULL WHERE id=?").bind(p.id),
    ...older.map((h) => db.prepare("UPDATE passages SET canonical=0, superseded_by=? WHERE id=?").bind(p.id, h.id)),
  ]);
  return { ok: true, superseded: older.length };
}

// ---- P13-09 private skill suggestions ---------------------------------------------------------

export const SUGGEST_MIN_REPLIES = 3;

/** Cron step (bounded): suggest a skill to members who answered several questions on it. */
export async function suggestSkills(db: D1Database, now = new Date()): Promise<string[]> {
  const since = nowIso(new Date(now.getTime() - 30 * DAY));
  const { results } = await db
    .prepare(
      "SELECT p.author_id, p.body, m.tg_id, m.lang FROM passages p JOIN members m ON m.id = p.author_id " +
        "WHERE p.part = 0 AND p.reply_to IS NOT NULL AND p.removed_at IS NULL AND p.event_at >= ? " +
        "AND m.removed_at IS NULL AND m.collection_opt_out = 0 AND (p.intent IS NULL OR p.intent != 'help_request') " +
        "AND p.author_id IN (SELECT author_id FROM passages WHERE reply_to IS NOT NULL AND event_at >= ? GROUP BY author_id HAVING COUNT(*) >= ?) " +
        "LIMIT 500",
    )
    .bind(since, since, SUGGEST_MIN_REPLIES)
    .all<{ author_id: string; body: string; tg_id: number; lang: Lang | null }>();
  const counts = new Map<string, { tg: number; lang: Lang; codes: Map<string, number> }>();
  for (const r of results) {
    const e = counts.get(r.author_id) ?? { tg: r.tg_id, lang: r.lang ?? defaultLang(), codes: new Map() };
    for (const c of matchSkills(r.body)) e.codes.set(c, (e.codes.get(c) ?? 0) + 1);
    counts.set(r.author_id, e);
  }
  const keys: string[] = [];
  for (const [memberId, e] of counts) {
    if (keys.length >= 10) break;
    for (const [code, n] of e.codes) {
      if (n < SUGGEST_MIN_REPLIES) continue;
      const known = await db
        .prepare("SELECT 1 FROM skills WHERE member_id=? AND code=? UNION SELECT 1 FROM skill_dismissed WHERE member_id=? AND code=?")
        .bind(memberId, code, memberId, code)
        .first();
      const key = `suggest:${memberId}:${code}`;
      if (known) continue;
      const t = T(e.lang);
      const r = await effectStatement(db, key, e.tg, {
        text: t.suggestSkill(escapeHtml(labelIn(TAXONOMY.get(code)!, e.lang))),
        buttons: [[{ text: t.bAddSkill, callback_data: `s:${code}:add` }, { text: t.bNoThanks, callback_data: `s:${code}:no` }]],
      }).run();
      if (r.meta.changes) keys.push(key);
      break; // one suggestion per member per run
    }
  }
  return keys;
}

export async function answerSuggestion(db: D1Database, memberId: string, code: string, accept: boolean): Promise<boolean> {
  if (!TAXONOMY.has(code)) return false;
  if (accept) {
    await db.prepare("INSERT INTO skills(member_id, code, state, kind) VALUES (?,?,'confirmed','teaching_contribution') ON CONFLICT(member_id, code) DO UPDATE SET state='confirmed'").bind(memberId, code).run();
  } else {
    await db.prepare("INSERT OR IGNORE INTO skill_dismissed(member_id, code) VALUES (?,?)").bind(memberId, code).run();
  }
  return true;
}

// ---- P13-10 events ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  янв: 1, фев: 2, мар: 3, апр: 4, мая: 5, май: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12,
}; // prettier-ignore

/** Find the first date (and optional HH:MM) in a message. Returns ISO in UTC, or null. */
export function parseEventDate(text: string, now: Date, tzOffsetMin = 0): string | null {
  const t = normalize(text);
  let y: number | undefined;
  let mo: number | undefined;
  let d: number | undefined;
  let m = /\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/.exec(t);
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!m && (m = /\b(\d{1,2})[./](\d{1,2})(?:[./](20\d\d))?\b/.exec(t))) [d, mo, y] = [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined];
  if (!mo && (m = /(\d{1,2})\s+([a-zа-я]{3,})/u.exec(t))) {
    const key = Object.keys(MONTHS).find((k) => m![2]!.startsWith(k));
    if (key) [d, mo] = [Number(m[1]), MONTHS[key]!];
  }
  if (!mo && (m = /([a-z]{3,})\s+(\d{1,2})\b/.exec(t))) {
    const key = Object.keys(MONTHS).find((k) => /^[a-z]/.test(k) && m![1]!.startsWith(k));
    if (key) [d, mo] = [Number(m[2]), MONTHS[key]!];
  }
  if (!mo || !d || mo > 12 || d > 31) return null;
  const tm = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(t);
  const [hh, mm] = tm ? [Number(tm[1]), Number(tm[2])] : [12, 0];
  let year = y ?? now.getUTCFullYear();
  let at = Date.UTC(year, mo - 1, d, hh, mm) - tzOffsetMin * 60_000;
  if (!y && at < now.getTime() - DAY) at = Date.UTC((year += 1), mo - 1, d, hh, mm) - tzOffsetMin * 60_000;
  return nowIso(new Date(at));
}

/** Called at ingest: store an upcoming event announced in an enabled group. */
export async function detectEvent(db: D1Database, sourceId: string, msgId: number, text: string, now = new Date(), tzOffsetMin = 0): Promise<boolean> {
  if (classify(text).intent !== "event") return false;
  const startsAt = parseEventDate(text, now, tzOffsetMin);
  if (!startsAt || Date.parse(startsAt) < now.getTime()) return false;
  const title = text.split("\n")[0]!.slice(0, 120);
  await db
    .prepare("INSERT OR IGNORE INTO events(source_id, msg_id, title, starts_at, created_at) VALUES (?,?,?,?,?)")
    .bind(sourceId, msgId, title, startsAt, nowIso(now))
    .run();
  return true;
}

export interface EventRow {
  source_id: string;
  msg_id: number;
  title: string;
  starts_at: string;
  chat_id: number;
  username: string | null;
}

export async function upcomingEvents(db: D1Database, readable: Set<string>, now = new Date()): Promise<EventRow[]> {
  if (!readable.size) return [];
  return (
    await db
      .prepare(
        "SELECT e.source_id, e.msg_id, e.title, e.starts_at, s.chat_id, s.username FROM events e JOIN sources s ON s.id = e.source_id AND s.enabled = 1 " +
          "JOIN passages p ON p.source_id = e.source_id AND p.msg_id = e.msg_id AND p.part = 0 AND p.removed_at IS NULL " +
          "WHERE e.hidden = 0 AND e.starts_at >= ? AND e.source_id IN (SELECT value FROM json_each(?)) ORDER BY e.starts_at LIMIT 15",
      )
      .bind(nowIso(now), JSON.stringify([...readable]))
      .all<EventRow>()
  ).results;
}

const icsText = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, " ");
const icsDate = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function toIcs(events: EventRow[]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Telepathy//events//EN"];
  for (const e of events) {
    const url = citation(e.chat_id, e.msg_id, e.username);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.source_id}-${e.msg_id}@telepathy`,
      `DTSTAMP:${icsDate(nowIso())}`,
      `DTSTART:${icsDate(e.starts_at)}`,
      `SUMMARY:${icsText(e.title)}`,
      ...(url ? [`URL:${url}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
