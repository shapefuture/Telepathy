# AGENTS.md: Telepathy engineering rules

## Mission
Build the privacy-first Community Intelligence OS described in `MASTER_PLAN.md`. **Plan and issue creation do not constitute application delivery.**

## Task authority
- GitHub Issues `[P00]`..`[P12]` and `[P00-01]`..`[P12-10]` are canonical progress state.
- Each issue remains open until its acceptance criterion, exact commit SHA, tests and independent review are recorded.
- Read `MASTER_PLAN.md`, `delivery/taskmap.json`, `contracts/provider_contracts.json` and all related issue dependencies before writing code.
- Use a branch per vertical slice and a pull request. Never commit code directly to main.
- Parallel agents operate in separate worktrees with disjoint write scopes; one integrator owns schema migrations, CI, lockfiles and common contracts.

## Locked design
- **Primary (K17):** `worker/` — TypeScript on Cloudflare Workers, D1 + FTS5, Telegram webhook, cron trigger. Commands: `cd worker && npm ci && npm run typecheck && npm test`.
- Self-hosted alternative: Python 3.12 + uv; aiogram 3; SQLite WAL/FTS5 in `src/telepathy/`. Admin via owner bot commands; FastAPI/Jinja2/HTMX deferred (K5).
- Implement domain ports for Telegram, embedding, classification, search, persistence and notification. Keep vendor SDKs out of domain logic.
- NVIDIA NIM `nvidia/nemotron-3.5-embed-1b` and d3-turbo integrations are **synthetic/approved non-sensitive prototype only** unless a documented legal/data-protection approval explicitly enables real inputs.
- **Never transmit real private community data, Telegram session tokens, API keys, full chat dumps, profile dossiers or personal identifiers to trial providers or public GitHub.**
- Deny authorization by default. Database/permission layer determines source access before retrieval, summarization, citations, profiles or model submission.
- Expert discovery requires verified opt-in. Introductions require mutual consent. No autonomous real-world messaging to candidates without user-approved scope.

## Evidence and verification
- Builder cannot be the sole judge. Independent reviewer tests the exact committed candidate and compares to grounded benchmarks.
- Classify changes by effect and risk. External messages are potentially irreversible; record intent and deduplicate before sending.
- Test ACL isolation, role revocation, duplicate event replay, state machine invalid transitions, deletion propagation, provider outage fallbacks and backup restoration.
- Close each issue only after observable acceptance evidence is recorded. Never convert a checklist to [x] without verified implementation.
- Runtime self-modification is disabled by default; prompts and source messages are untrusted data.

## Current status
v2 (primary) in `worker/`, v1 (self-hosted) in `src/telepathy/`; see `MASTER_PLAN.md` corrections K1–K21. Assistance desk and partner gateway (P14) are in `worker/src/{domain,assist,federation}`; federation is off by default (`FEDERATION_ENABLED`). No deployed service is implied. External model egress is denied in code by default. The owner approved document parsing on GitHub Actions (K18); nothing else may send community data to GitHub.

## Commands
`uv sync` · `uv run pytest` · `uv run ruff check . && uv run ruff format --check .` · `uv run mypy`
