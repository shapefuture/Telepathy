# Telepathy

Telepathy is a privacy-first **Community Intelligence OS** for Telegram communities:
source-cited knowledge retrieval, approved meeting/document search, verified opt-in
expert discovery, and consent-based introductions.

**Status:** early prototype (first core slice). Not deployed, and no plan gate is closed.
See [`docs/PLAN_REVIEW.md`](docs/PLAN_REVIEW.md) for what exists and what is next.

**Important:** Do not upload Telegram chat transcripts, credentials, private member
details, or identifiable data to this public repository. NVIDIA NIM trial and Decision 3.0
integrations are prototype-only until privacy and terms-of-service gates are satisfied.
The code denies all external model egress by default.

## What works today

- The bot ingests messages **only** from groups an owner enabled with `/enable`. Storage
  is idempotent, handles edits arriving out of order, and keeps no names, usernames or phones.
- `/ask <question>` in a private chat returns verbatim, linked quotes, and only from groups
  the asker can read. It says "no reliable answer" instead of guessing.
- Built-in pieces for later phases: job ledger, send outbox, introduction state machine,
  egress guard, rule-based classifier.

## Layout

```
src/telepathy/
  domain/      pure logic: types, text normalization, egress guard, classifier, intro FSM
  storage/     SQLite schema + migrations, ACL, job ledger, effect outbox
  ingest/      Telegram message normalization and idempotent ingestion
  retrieval/   ACL-first FTS5 search, RRF fusion, citation verification, extractive answers
  bot/         aiogram adapter (the only place that imports aiogram)
  ports.py     interfaces for embedder / classifier / notifier
```

## Develop

```bash
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check .
uv run mypy
```

## Run a test bot

1. Create a bot with @BotFather. **Disable privacy mode** (`/setprivacy` → Disable) so it
   can see group messages, and add it to the group as an admin (needed for member
   join/leave updates).
2. `cp .env.example .env` and fill in `TELEPATHY_BOT_TOKEN` and `TELEPATHY_OWNER_IDS`.
   Never commit `.env`.
3. `set -a; . ./.env; set +a; uv run telepathy`
4. In the group, an owner who is also a chat admin sends `/enable` (default visibility
   `MEMBER_CONSENTED`) or `/enable PUBLIC_APPROVED`. `/disable` stops collection, and
   existing messages drop out of answers immediately.
5. Members DM the bot: `/ask where is the next meetup?`

Visibility rules: `PUBLIC_APPROVED` is readable by every community member;
`MEMBER_CONSENTED` by members seen in that group; `INTERNAL_RESTRICTED` only by
moderators and above who are in that group; `PRIVATE_UNKNOWN` by nobody.

Known Bot API limits: bots get no deletion events, so removals go through
`ingest.service.remove_message`. History before the bot joined is not imported.
