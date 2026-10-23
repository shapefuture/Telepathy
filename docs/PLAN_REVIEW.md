# Plan review: MASTER_PLAN v1.0 → first code slice

This reviews the plan in PR #33 (`MASTER_PLAN.md`, `architecture/*`, `contracts/*`) and
records what the first code slice implements, what it changes, and what needs a decision.

**Status:** this is a pre-gate prototype. No plan checkbox or issue is complete. P00
(governance approvals) is still open, and nothing here touches real community data.

## What the plan gets right

- **Deny-by-default access, checked before scoring.** This is the right core invariant.
  The code applies it inside the candidate SQL query, not as a post-filter.
- **Extractive, cited answers first.** No generation means no hallucination risk and no
  need to send private text to a provider. FTS5 alone can run a useful MVP.
- **Outbox with an "uncertain" state.** This is the honest model for Telegram sends,
  which cannot be exactly-once.
- **One node: SQLite WAL, no Redis/Postgres.** This fits a single community with
  about 100k messages.

## Gaps and inconsistencies found (and how this slice resolves them)

| # | Issue | Resolution here |
|---|---|---|
| 1 | Reference schema has no roles or memberships, so `INTERNAL_RESTRICTED` and P02-03 `permitted_roles` cannot be enforced | Added `members.role` and a `source_access` grant table; rules live in `storage/acl.py` |
| 2 | P03-03 dedup key includes `edit_revision`, but `messages` has no revision marker for out-of-order edits | Added `messages.edit_version` (Telegram `edit_date`); older edits are recorded but never applied |
| 3 | `effect_intents` cannot tell "never sent" from "crashed mid-send" | Added a `dispatching` state; on restart it becomes `uncertain` and is never resent automatically |
| 4 | `UNIQUE(need_id, candidate_id)` does not enforce P09-02 "max 1 invitation at once per request" | Partial unique index `uq_intro_one_live_invite` |
| 5 | FTS keyed by an `UNINDEXED excerpt_id`, so every delete or edit scans the whole table | FTS `rowid` = `excerpts.rowid` |
| 6 | `raw_events.raw_json` would keep names, usernames and contact cards, against P03-04 pseudonymity | Only minimized normalized fields are stored, and they are blanked on deletion |
| 7 | **Ambiguous cap:** P09-02 says "2 pending requests per *member*/week"; `system.yaml` says `per_expert_pending_weekly_max: 2` | **Needs a product decision:** a cap on requesters, on experts, or both (recommended: both) |
| 8 | P10-09 says "if LLM unavailable", but `genai.initial_mode` is extractive-only, so there is no LLM | Treat the deterministic digest as the default, not a fallback |
| 9 | FTS5 `unicode61` has no Russian stemming or transliteration. P06-06 and QG02 (recall@10 ≥ 0.85 RU/EN/mixed) are unlikely to pass on FTS alone | Prefix queries cover common inflection. A **local** embedder (e5-small, already named as the fallback) is likely needed, since external embeddings are legally gated |
| 10 | Bot API limits: privacy mode hides most group messages, no deletion events, `chat_member` updates need the bot to be admin | Documented in README setup. Deletion uses `remove_message` (admin or reconciliation) |
| 11 | P00-04 (200-case gold fixture) blocks every numeric gate but sits inside a 10-item governance phase | Pull it forward: no retrieval or classifier work can be evaluated without it |

## Sequencing recommendation

The plan has 130 tasks in 13 phases (10 per phase). For a single-community MVP, the
critical path is:

1. **P02 core schema/ACL → P03 ingest → P06 /ask on FTS5** (this slice: a working,
   privacy-safe bot with no external providers).
2. **P00-04 gold fixture + P00-10 approvals** in parallel, because every numeric gate depends on them.
3. **P08/P09 experts and intros**, which are mostly local logic (the state machine is done).
4. **P04/P05 external adapters last.** They stay disabled until P00-08/QG09 legal
   approvals, so building them early adds risk without user value. Embeddings plug into
   `retrieval.search.search(semantic=...)` via RRF once approved.

## Implemented in this slice

| Plan item | Module |
|---|---|
| P01-05 uv/ruff/mypy/pytest, lockfile | `pyproject.toml`, `uv.lock`, `.github/workflows/ci.yml` |
| P01-07 ports | `ports.py` |
| P01-08 architecture import fence | `tests/test_architecture.py` |
| P02-01..08 schema, ACL, FTS, jobs, outbox | `storage/migrations/0001_init.sql`, `storage/*` |
| P02-09 forward-only migrations | `storage/db.py` |
| P02-10 negative ACL tests | `tests/test_acl.py` |
| P03-01/02 bot, owner-only source allowlist | `bot/handlers.py`, `ingest/service.py` |
| P03-03/04/07/08/09 idempotency, normalization, checkpoint, edit/delete, media IDs only | `ingest/*` |
| P04-02/03 egress guard + redaction (deny by default) | `domain/egress.py` |
| P04-07/09 thresholds + rule-based fallback classifier | `domain/classify.py` |
| P05-07/08/09 FTS fallback, RRF(k=60), citation verifier | `retrieval/search.py` |
| P06-01..05, P06-09 identity, ACL gate, extractive answer, abstention, deep links, injection-safe output | `retrieval/answer.py`, `bot/handlers.py` |
| P09-03/04/05 intro state machine, two-party consent, expiry | `domain/intro.py`, `tests/test_intro.py` |

## Not yet implemented

NVIDIA and d3 HTTP adapters (blocked on approvals), documents and transcripts (P07),
expert directory and ranking (P08), intro persistence and bot flow (P09 wiring),
digests (P10), admin UI (P11), backups, systemd unit, evaluation harness (P12).
