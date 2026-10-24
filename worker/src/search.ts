// Hybrid fuzzy retrieval (P05-07..09, P06).
//
//   lexical list : FTS5 over query terms + prefix + RU<->Latin transliteration
//   fuzzy list   : FTS5 over typo-corrected terms taken from the index's own vocabulary
//   fusion       : Reciprocal Rank Fusion, k = 60
//
// Authorization is inside the candidate SQL (source_id IN readable set), so hidden evidence
// is never scored, ranked or snippeted. Message text is evidence only; nothing in it is obeyed.

import { T, type Lang } from "./i18n";
import { citation } from "./ingest";
import type { InlineButton } from "./telegram";
import { contentTerms, editDistance, escapeHtml, ftsQuery, normalize, snippet, stemKey, termPresent, tokens, variants } from "./text";

export const TOP_K = 40;
export const RRF_K = 60;
export const MAX_QUOTES = 3;
export const MIN_COVERAGE = 0.5;
const VOCAB_SCAN_LIMIT = 400;

export interface Hit {
  id: number;
  msg_id: number;
  source_id: string;
  body: string;
  label: string | null;
  event_at: string;
  url: string | null;
  score: number;
  canonical: number;
  superseded_by: number | null;
}

interface Row {
  id: number;
  source_id: string;
  body: string;
  label: string | null;
  event_at: string;
  msg_id: number;
  topic_id: number | null;
  chat_id: number;
  username: string | null;
  canonical: number;
  superseded_by: number | null;
}

/** P13-08 filters. They only narrow results; the readable set is never widened. */
export interface SearchFilters {
  since?: string; // ISO timestamp
  hasFile?: boolean;
}

function candidatesSql(f: SearchFilters): string {
  return (
    "SELECT p.id, p.source_id, p.body, p.label, p.event_at, p.msg_id, p.topic_id, p.canonical, p.superseded_by, s.chat_id, s.username " +
    "FROM passages_fts f JOIN passages p ON p.id = f.rowid JOIN sources s ON s.id = p.source_id " +
    "WHERE passages_fts MATCH ? AND p.removed_at IS NULL AND p.body IS NOT NULL AND s.enabled = 1 " +
    "AND p.source_id IN (SELECT value FROM json_each(?)) " +
    (f.since ? "AND p.event_at >= ? " : "") +
    (f.hasFile ? "AND p.part > 0 " : "") +
    "ORDER BY bm25(passages_fts) LIMIT ?"
  );
}

/** P13-07: canonical answers rank first; superseded ones sink (but stay findable, labelled). */
export const CANONICAL_BOOST = 0.01;
export const OUTDATED_PENALTY = 0.006;

export function rrf(lists: number[][], k = RRF_K): [number, number][] {
  const scores = new Map<number, number>();
  for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

/**
 * Typo correction from the index vocabulary. Only terms with no prefix match in the index
 * are corrected, so correct-but-inflected words are left alone.
 */
export async function corrections(db: D1Database, terms: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const candidates = terms.filter((t) => t.length >= 4).slice(0, 4);
  if (!candidates.length) return out;
  const exists = await db.batch(
    candidates.map((t) => {
      const key = stemKey(t);
      return db.prepare("SELECT term FROM passages_vocab WHERE term >= ? AND term < ? LIMIT 1").bind(key, `${key}￿`);
    }),
  );
  const missing = candidates.filter((_, i) => !exists[i]!.results.length);
  if (!missing.length) return out;
  // Typos rarely hit the first two letters: scan vocabulary sharing them, bounded.
  const scans = await db.batch(
    missing.map((t) => {
      const head = t.slice(0, 2);
      return db
        .prepare("SELECT term, doc FROM passages_vocab WHERE term >= ? AND term < ? LIMIT ?")
        .bind(head, `${head}￿`, VOCAB_SCAN_LIMIT);
    }),
  );
  missing.forEach((t, i) => {
    const max = t.length <= 6 ? 1 : 2;
    let best: { term: string; d: number; doc: number } | null = null;
    for (const r of scans[i]!.results as { term: string; doc: number }[]) {
      // Compare against the same-length prefix so inflected vocabulary still matches.
      const cand = r.term.length > t.length + max ? r.term.slice(0, t.length) : r.term;
      const d = editDistance(t, cand, max);
      if (d <= max && (!best || d < best.d || (d === best.d && r.doc > best.doc))) best = { term: r.term, d, doc: r.doc };
    }
    if (best && best.term !== t) out.set(t, best.term);
  });
  return out;
}

/**
 * Small ranking nudge from private answer feedback (P13-05). One RRF rank step at k=60 is about
 * 0.0003, so ±0.004 can lift a well-rated passage a few places but never invents relevance.
 */
export const VOTE_WEIGHT = 0.004;
export async function voteBoost(db: D1Database, ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!ids.length) return out;
  const { results } = await db
    .prepare("SELECT passage_id, up, down, bad FROM passage_votes WHERE passage_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .all<{ passage_id: number; up: number; down: number; bad: number }>();
  for (const r of results) {
    const net = r.up - r.down - 2 * r.bad;
    out.set(r.passage_id, VOTE_WEIGHT * Math.max(-1, Math.min(1, net / 3)));
  }
  return out;
}

export async function search(
  db: D1Database,
  readable: Set<string>,
  query: string,
  filters: SearchFilters = {},
): Promise<{ hits: Hit[]; terms: string[]; fixes: Map<string, string> }> {
  const terms = contentTerms(query);
  const base = terms.length ? terms : tokens(query).filter((t) => t.length > 1);
  const fixes = new Map<string, string>();
  if (!base.length || !readable.size) return { hits: [], terms: base, fixes };
  const lexical = ftsQuery(base.slice(0, 16).flatMap((t) => [t, ...variants(t)]));
  for (const [k, v] of await corrections(db, base)) fixes.set(k, v);
  const fuzzy = fixes.size ? ftsQuery([...fixes.values()]) : null;
  const src = JSON.stringify([...readable].sort());
  const queries = [lexical, fuzzy].filter((q): q is string => !!q);
  const sql = candidatesSql(filters);
  const bind = (q: string) => (filters.since ? [q, src, filters.since, TOP_K] : [q, src, TOP_K]);
  const results = await db.batch(queries.map((q) => db.prepare(sql).bind(...bind(q))));
  const rows = new Map<number, Row>();
  const lists = results.map((r) =>
    (r.results as unknown as Row[]).map((row) => {
      rows.set(row.id, row);
      return row.id;
    }),
  );
  const fused = rrf(lists);
  const boost = await voteBoost(db, fused.map(([id]) => id));
  const hits = fused
    .map(([id, score]) => {
      const r = rows.get(id)!;
      const editorial = r.canonical ? CANONICAL_BOOST : r.superseded_by ? -OUTDATED_PENALTY : 0;
      return [id, score + (boost.get(id) ?? 0) + editorial] as [number, number];
    })
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([id, score]) => {
    const r = rows.get(id)!;
    return {
      id,
      msg_id: r.msg_id,
      source_id: r.source_id,
      body: r.body,
      label: r.label,
      event_at: r.event_at,
      url: citation(r.chat_id, r.msg_id, r.username, r.topic_id),
      score,
      canonical: r.canonical,
      superseded_by: r.superseded_by,
    };
  });
  // Belt and braces: re-check authorization on the final list (C02).
  return { hits: hits.filter((h) => readable.has(h.source_id)), terms: base, fixes };
}

export type AnswerStatus = "answered" | "insufficient" | "no_access" | "empty";

export interface Quote {
  id: number;
  text: string;
  label: string | null;
  event_at: string;
  url: string | null;
  coverage: number;
  tag?: "canonical" | "outdated";
}

export async function answer(db: D1Database, readable: Set<string>, query: string, filters: SearchFilters = {}): Promise<Answer> {
  const terms = contentTerms(query);
  if (!terms.length) return { status: "empty", quotes: [], fixes: new Map() };
  if (!readable.size) return { status: "no_access", quotes: [], fixes: new Map() };
  const { hits, fixes } = await search(db, readable, query, filters);
  const quotes: Quote[] = [];
  for (const h of hits) {
    const folded = normalize(h.body);
    const present = terms.filter((t) => termPresent(t, folded, fixes.has(t) ? [fixes.get(t)!] : [])).length;
    const coverage = present / terms.length;
    if (coverage >= MIN_COVERAGE) {
      const keys = terms.flatMap((t) => [t, ...(fixes.has(t) ? [fixes.get(t)!] : [])]);
      const tag = h.canonical ? "canonical" : h.superseded_by ? "outdated" : undefined;
      quotes.push({ id: h.id, text: snippet(h.body, keys), label: h.label, event_at: h.event_at, url: h.url, coverage, ...(tag ? { tag } : {}) });
    }
  }
  // Canonical answers first, then coverage; stable sort keeps rank order among ties.
  quotes.sort((a, b) => Number(b.tag === "canonical") - Number(a.tag === "canonical") || b.coverage - a.coverage);
  return { status: quotes.length ? "answered" : "insufficient", quotes: quotes.slice(0, MAX_QUOTES), fixes };
}

export type Answer = { status: AnswerStatus; quotes: Quote[]; fixes: Map<string, string> };

/**
 * Telegram HTML for an answer. `answerId` adds private feedback buttons (P13-05);
 * scope "group" words the reply for an in-group answer (P13-01).
 */
export function renderAnswer(
  a: Answer,
  tz: string,
  lang: Lang = "en",
  opts: { scope?: "dm" | "group"; answerId?: string } = {},
): { text: string; buttons?: InlineButton[][] } {
  const m = T(lang);
  if (a.status === "empty") return { text: m.askUsage };
  if (a.status === "no_access") return { text: m.noAccess };
  if (a.status === "insufficient") return { text: opts.scope === "group" ? m.insufficientGroup : m.insufficient };
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const lines = [opts.scope === "group" ? m.foundGroup(a.quotes.length) : m.found(a.quotes.length)];
  if (a.fixes.size) lines.push(m.alsoSearched(escapeHtml([...a.fixes].map(([k, v]) => `${k} → ${v}`).join(", "))));
  a.quotes.forEach((q, i) => {
    const when = date.format(new Date(q.event_at));
    const src = q.url ? `<a href="${escapeHtml(q.url)}">${m.source}</a>` : m.sourceUnavailable;
    const label = (q.label ? ` · ${escapeHtml(q.label)}` : "") + (q.tag === "canonical" ? ` · ${m.canonicalTag}` : q.tag === "outdated" ? ` · ${m.outdatedTag}` : "");
    lines.push(`\n${i + 1}. <blockquote>${escapeHtml(q.text)}</blockquote>\n${when}${label} · ${src}`);
  });
  if (!opts.answerId) return { text: lines.join("\n") };
  const id = opts.answerId;
  const buttons: InlineButton[][] = [
    [
      { text: m.fbHelpful, callback_data: `f:${id}:up` },
      { text: m.fbNotHelpful, callback_data: `f:${id}:down` },
    ],
    a.quotes.map((_, i) => ({ text: m.fbWrong(i + 1), callback_data: `f:${id}:bad${i}` })),
  ];
  return { text: lines.join("\n"), buttons };
}

/**
 * P13-08: parse `in:<group> since:<date|Nd|Nh> has:file` out of a query.
 * `in:` keeps only readable groups whose title contains the word, so it can only narrow access.
 */
export async function parseFilters(
  db: D1Database,
  readable: Set<string>,
  raw: string,
  now = new Date(),
): Promise<{ query: string; readable: Set<string>; filters: SearchFilters }> {
  const filters: SearchFilters = {};
  let scope = readable;
  const rest: string[] = [];
  for (const tok of raw.split(/\s+/)) {
    const m = /^(in|since|has):(.+)$/i.exec(tok);
    if (!m) {
      rest.push(tok);
      continue;
    }
    const [, key, val] = m as unknown as [string, string, string];
    if (key.toLowerCase() === "has" && val.toLowerCase() === "file") filters.hasFile = true;
    else if (key.toLowerCase() === "since") {
      const rel = /^(\d+)([hd])$/i.exec(val);
      const t = rel ? now.getTime() - Number(rel[1]) * (rel[2]!.toLowerCase() === "h" ? 3_600_000 : 86_400_000) : Date.parse(val);
      if (Number.isFinite(t)) filters.since = new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
      else rest.push(tok);
    } else if (key.toLowerCase() === "in") {
      const { results } = await db
        .prepare("SELECT id FROM sources WHERE enabled = 1 AND lower(COALESCE(title, '')) LIKE ? AND id IN (SELECT value FROM json_each(?))")
        .bind(`%${val.toLowerCase().replaceAll("%", "").replaceAll("_", "")}%`, JSON.stringify([...scope]))
        .all<{ id: string }>();
      scope = new Set(results.map((r) => r.id).filter((id) => scope.has(id)));
    } else rest.push(tok);
  }
  return { query: rest.join(" ").trim(), readable: scope, filters };
}
