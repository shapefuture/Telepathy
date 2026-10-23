// Hybrid fuzzy retrieval (P05-07..09, P06).
//
//   lexical list : FTS5 over query terms + prefix + RU<->Latin transliteration
//   fuzzy list   : FTS5 over typo-corrected terms taken from the index's own vocabulary
//   fusion       : Reciprocal Rank Fusion, k = 60
//
// Authorization is inside the candidate SQL (source_id IN readable set), so hidden evidence
// is never scored, ranked or snippeted. Message text is evidence only; nothing in it is obeyed.

import { citation } from "./ingest";
import { contentTerms, editDistance, escapeHtml, ftsQuery, normalize, snippet, stemKey, termPresent, tokens, variants } from "./text";

export const TOP_K = 40;
export const RRF_K = 60;
export const MAX_QUOTES = 3;
export const MIN_COVERAGE = 0.5;
const VOCAB_SCAN_LIMIT = 400;

export interface Hit {
  id: number;
  source_id: string;
  body: string;
  label: string | null;
  event_at: string;
  url: string | null;
  score: number;
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
}

const CANDIDATES_SQL =
  "SELECT p.id, p.source_id, p.body, p.label, p.event_at, p.msg_id, p.topic_id, s.chat_id, s.username " +
  "FROM passages_fts f JOIN passages p ON p.id = f.rowid JOIN sources s ON s.id = p.source_id " +
  "WHERE passages_fts MATCH ? AND p.removed_at IS NULL AND p.body IS NOT NULL AND s.enabled = 1 " +
  "AND p.source_id IN (SELECT value FROM json_each(?)) ORDER BY bm25(passages_fts) LIMIT ?";

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

export async function search(db: D1Database, readable: Set<string>, query: string): Promise<{ hits: Hit[]; terms: string[]; fixes: Map<string, string> }> {
  const terms = contentTerms(query);
  const base = terms.length ? terms : tokens(query).filter((t) => t.length > 1);
  const fixes = new Map<string, string>();
  if (!base.length || !readable.size) return { hits: [], terms: base, fixes };
  const lexical = ftsQuery(base.slice(0, 16).flatMap((t) => [t, ...variants(t)]));
  for (const [k, v] of await corrections(db, base)) fixes.set(k, v);
  const fuzzy = fixes.size ? ftsQuery([...fixes.values()]) : null;
  const src = JSON.stringify([...readable].sort());
  const queries = [lexical, fuzzy].filter((q): q is string => !!q);
  const results = await db.batch(queries.map((q) => db.prepare(CANDIDATES_SQL).bind(q, src, TOP_K)));
  const rows = new Map<number, Row>();
  const lists = results.map((r) =>
    (r.results as unknown as Row[]).map((row) => {
      rows.set(row.id, row);
      return row.id;
    }),
  );
  const hits = rrf(lists).map(([id, score]) => {
    const r = rows.get(id)!;
    return {
      id,
      source_id: r.source_id,
      body: r.body,
      label: r.label,
      event_at: r.event_at,
      url: citation(r.chat_id, r.msg_id, r.username, r.topic_id),
      score,
    };
  });
  // Belt and braces: re-check authorization on the final list (C02).
  return { hits: hits.filter((h) => readable.has(h.source_id)), terms: base, fixes };
}

export type AnswerStatus = "answered" | "insufficient" | "no_access" | "empty";

export interface Quote {
  text: string;
  label: string | null;
  event_at: string;
  url: string | null;
  coverage: number;
}

export async function answer(db: D1Database, readable: Set<string>, query: string): Promise<{ status: AnswerStatus; quotes: Quote[]; fixes: Map<string, string> }> {
  const terms = contentTerms(query);
  if (!terms.length) return { status: "empty", quotes: [], fixes: new Map() };
  if (!readable.size) return { status: "no_access", quotes: [], fixes: new Map() };
  const { hits, fixes } = await search(db, readable, query);
  const quotes: Quote[] = [];
  for (const h of hits) {
    const folded = normalize(h.body);
    const present = terms.filter((t) => termPresent(t, folded, fixes.has(t) ? [fixes.get(t)!] : [])).length;
    const coverage = present / terms.length;
    if (coverage >= MIN_COVERAGE) {
      const keys = terms.flatMap((t) => [t, ...(fixes.has(t) ? [fixes.get(t)!] : [])]);
      quotes.push({ text: snippet(h.body, keys), label: h.label, event_at: h.event_at, url: h.url, coverage });
    }
  }
  quotes.sort((a, b) => b.coverage - a.coverage); // stable: keeps RRF order among ties
  return { status: quotes.length ? "answered" : "insufficient", quotes: quotes.slice(0, MAX_QUOTES), fixes };
}

export function renderAnswer(a: { status: AnswerStatus; quotes: Quote[]; fixes: Map<string, string> }, tz: string): string {
  if (a.status === "empty") return "Usage: <code>/ask your question</code>";
  if (a.status === "no_access") {
    return "I don't have any community sources you're allowed to read yet. Post in an enabled group first, or ask an admin.";
  }
  if (a.status === "insufficient") {
    return "<b>No reliable answer found</b> in sources you can access.\nTry different wording, or ask the community directly.";
  }
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const lines = [`<b>Found ${a.quotes.length} relevant message(s)</b> — quoted verbatim, please check the source:`];
  if (a.fixes.size) {
    lines.push(`<i>Also searched: ${escapeHtml([...a.fixes].map(([k, v]) => `${k} → ${v}`).join(", "))}</i>`);
  }
  a.quotes.forEach((q, i) => {
    const when = date.format(new Date(q.event_at));
    const src = q.url ? `<a href="${escapeHtml(q.url)}">source</a>` : "source link unavailable";
    const label = q.label ? ` · ${escapeHtml(q.label)}` : "";
    lines.push(`\n${i + 1}. <blockquote>${escapeHtml(q.text)}</blockquote>\n${when}${label} · ${src}`);
  });
  return lines.join("\n");
}
