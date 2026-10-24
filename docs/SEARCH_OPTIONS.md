# Hybrid fuzzy search: options and recommendation

Requirements (from the plan and your input): Russian + English, typo-tolerant, semantic
matching, **full history** (no cap), source-cited results, and **no community content sent to
third parties** without approval (C03, C14).

## What "hybrid fuzzy" needs to be three things

| Layer | Job | Failure it prevents |
|---|---|---|
| Lexical (BM25 / FTS5 + stemming) | exact and inflected words | misses "бухгалтера" when you search "бухгалтер" (without stemming) |
| Fuzzy (typo correction over the term vocabulary) | "accountnat" → "accountant" | FTS5 alone has no typo handling |
| Semantic (embeddings + kNN) | "who does my taxes" ↔ "tax advisor" | pure keyword search misses paraphrases |

They are fused with **Reciprocal Rank Fusion (k = 60)**, which the plan already locks. Sources
(blog/forum, not benchmarked): the SQLite pattern of FTS5 + sqlite-vec merged with RRF is in
use by at least one open-source MCP server ([gnosis-mcp](https://glama.ai/mcp/servers/@nicholasglazer/gnosis-mcp/blob/c98bf9ef8f3067a6a63b78e3c3ff9c126d52042c/src/gnosis_mcp/sqlite_backend.py)).

## Options compared

| Option | Typo tolerance | Semantic | Full history | Cost | Fit |
|---|---|---|---|---|---|
| **A. SQLite FTS5 + Snowball stemming + vocabulary typo correction** (SymSpell or rapidfuzz) | yes (via correction layer) | no (add later) | yes | free | **Recommended now.** Keeps one database and the plan's architecture. |
| FTS5 `trigram` tokenizer | **no**: substring matching only. Sources say it cannot express "within 2 edits" and ranks poorly. | no | yes | free | Useful for CJK/partial words, not for typos. |
| **sqlite-vec** kNN + RRF (already planned) | n/a | yes | yes | free | **Recommended next**, once the gold set shows a recall gap. |
| Typesense (self-hosted) | yes, built in | yes (hybrid) | yes | free server, needs RAM for the whole index | Good if SQLite becomes too slow. Adds a second store to keep in sync. Check the license: sources disagree (vendor pages say GPL-3 vs MIT). |
| Meilisearch (self-hosted) | yes, built in | yes (hybrid) | yes | free server; replication needs Enterprise or Cloud | Same trade-off as Typesense. No free HA. |
| OpenSearch / Elasticsearch | yes | yes | yes | heavy, RAM-hungry | Overkill for one community. |
| PostgreSQL + pgvector + pg_trgm | yes (trigram similarity) | yes | yes | free self-hosted | Strong all-in-one, but the plan locks **SQLite, no PostgreSQL**. Needs your approval to change. |
| Cloudflare Vectorize + Workers AI embeddings | depends on layer | yes | yes | free tier exists (limits not verified here) | **Blocked for community text**: embedding sends content to Cloudflare, which the constitution forbids without approval (C03/C14). Acceptable only for public, approved sources. |

## Also evaluated: nanograph (2026-10-23)

[nanograph](https://github.com/nanograph/nanograph) is an embedded, on-device property-graph
database ("DuckDB for graphs") written in Rust on Lance/Arrow/DataFusion. Its README lists
full-text, BM25, fuzzy, semantic and hybrid search, graph-constrained reranking, a change ledger,
and an MIT license. It has a TypeScript/Node SDK.

**Not adopted for now:**
- **It can't run in the Worker.** It needs a local filesystem and native Rust binaries; the
  README mentions no WASM or edge build, and Workers have no disk and 10 ms of CPU.
- **The plan rules out a graph DB** until a benchmark shows a gain: SQLite relational links +
  CTEs are the locked choice (TRIZ table, "lightweight storage vs graph reasoning").
- **It's early:** about 158 stars, no published releases, and no benchmarks in the README.

**Where it could fit later:** as an offline analysis job on GitHub Actions or a VPS, for example
an expert/relationship graph built from D1 exports, or if the bot ever moves off Workers.
Re-evaluate once it has releases and the gold set exists to measure it.

## Embedding models (for the semantic layer, after the gold set exists)

- **multilingual-e5-large-instruct** (560M parameters): the source I found calls it the best
  publicly available model in the MMTEB multilingual benchmark (see
  [Russian-focused embedders paper](https://arxiv.org/html/2408.12503v1) and MMTEB coverage).
- **bge-m3** and **ru-en-RoSBERTa** (Russian-focused, released with the ruMTEB benchmark): strong
  candidates for Russian. I could not retrieve current 2026 scores for bge-m3, so measure it.
- **Rule:** pick by score on **your** 200-case RU/EN/mixed gold set (P00-04), not by leaderboard.
  The plan's gate is recall@10 ≥ 0.85 and citation precision ≥ 0.95.

Hosting: a 560M-parameter model runs on CPU on a small VPS. Indexing is one-time per message,
and query embedding takes milliseconds. It does not run on a free Cloudflare Worker (CPU limit).

## Recommendation

1. **Now (no new service):** Option A. Add Snowball stemming (Russian and English, via
   `PyStemmer`), keep transliteration, and add typo correction over the term vocabulary
   (`SymSpell` symmetric-delete, or `rapidfuzz` against the indexed vocabulary). Stays in one
   SQLite file. Test on the gold set.
2. **After the gold set exists:** add sqlite-vec with `multilingual-e5-large-instruct` or
   `bge-m3`, computed on your own host. Fuse with the lexical and fuzzy lists using RRF (k = 60).
   Enable only if it wins the blind comparison on your gold set.
3. **Only if SQLite misses the latency target at full-history scale** (QG08: p95 ≤ 8 s): consider
   Typesense. It is the better fit than Meilisearch for a self-hosted, free setup.
4. Re-rank the top results with a cross-encoder only if measurement shows a precision gap.

## Full history and the search depth

"Full history" does not change search quality. Retrieval looks at the top 40 lexical matches and
the top 40 semantic matches across all history, then returns the best 3 quotes (`MAX_QUOTES`).
Those are ranking limits, not history limits. If you want more quotes per answer, raise
`MAX_QUOTES` (currently 3).
