# Telepathy

Telepathy is a privacy-first **Community Intelligence OS** for Telegram communities:
source-cited knowledge retrieval, approved meeting/document search, verified opt-in
expert discovery, and consent-based introductions.

**Status:** v1 code complete for a single community. It is not deployed yet: the launch
checklist in [`docs/PLAN_REVIEW.md`](docs/PLAN_REVIEW.md) still needs owner sign-off, an
independent review and a pilot. Operators: see [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

**Important:** Do not upload Telegram chat transcripts, credentials, private member
details, or identifiable data to this public repository. External AI providers are not
called; the egress guard denies them by default.

## Features

- **Cited search:** `/ask` in a DM returns verbatim quotes with links, only from groups the
  asker can read, including attached documents (PDF, Word, PowerPoint, text, subtitles with
  timestamps). It handles Russian/English and transliterated spellings, and says "no
  reliable answer" instead of guessing.
- **Experts:** members `/optin` and list skills from a 100-skill RU/EN taxonomy. `/expert`
  shows only how many people match, never who.
- **Introductions:** `/intro <need>` invites the best-matching expert anonymously. Contacts
  are exchanged only after the expert accepts **and** the requester confirms. Weekly caps,
  72 h expiry, one reminder, private feedback.
- **Daily digest:** admin-only summary of activity, open/answered questions and new
  documents.
- **Data rights:** `/forget_me`, `/forget` (reply to a message), per-group retention, nightly
  purge.
- **Ops:** verified daily backups, `/status` metrics, crash-safe sends (`/uncertain` to
  reconcile), systemd unit and Dockerfile.

## Layout

```
src/telepathy/
  domain/      pure logic: text/translit, egress guard, classifier, expert scoring, intro FSM
  storage/     SQLite migrations, ACL, experts, job ledger, effect outbox
  ingest/      Telegram normalization, idempotent ingest, documents, history import
  retrieval/   ACL-first FTS5 search, RRF fusion, citation verification, extractive answers
  services/    workflows: introductions, digest, data rights and retention
  ops/         backups, status metrics
  worker.py    background loop: sends, expiries, reminders, scheduled jobs
  bot/         aiogram adapter (the only place that imports aiogram)
deploy/        systemd unit, docker-compose, off-host backup example
```

## Develop

```bash
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check .
uv run mypy
```

## Run

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for production. Quick local run:

```bash
cp .env.example .env   # set TELEPATHY_BOT_TOKEN and TELEPATHY_OWNER_IDS; never commit it
set -a; . ./.env; set +a
uv run telepathy        # or: telepathy migrate | import FILE | backup | verify FILE | status
```

In BotFather, turn privacy mode **off**. Add the bot to a group as admin, and send `/enable`
there as an owner.
