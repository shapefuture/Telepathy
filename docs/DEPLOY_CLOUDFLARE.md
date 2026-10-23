# Deploy runbook: Cloudflare Workers (free plan)

Telepathy v2 runs as one Cloudflare Worker (`worker/`) with a D1 database. Telegram sends updates
to the Worker by webhook; a cron trigger every 5 minutes handles sends, expiries, reminders, the
daily digest and optional retention. There is no server to run.

## 0. What you need

- A Cloudflare account (free plan is enough to start).
- Node.js 22 and this repository.
- A bot from @BotFather. In BotFather run `/setprivacy` → **Disable**, so the bot can see group
  messages. Run `/setjoingroups` → Disable after you've added it to your groups.
- Your numeric Telegram user id (for example from @userinfobot).

## 1. First deployment (about 15 minutes)

```bash
cd worker
npm ci
npx wrangler login                       # opens a browser once

npx wrangler d1 create telepathy         # prints a database_id
# paste that id into wrangler.jsonc -> d1_databases[0].database_id
npm run db:migrate:remote                # creates the schema in D1

# Secrets (each command prompts for the value; nothing is written to disk):
npx wrangler secret put BOT_TOKEN        # from BotFather
openssl rand -hex 32                     # use the output for the next two
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ADMIN_TOKEN      # at least 16 characters
npx wrangler secret put OWNER_IDS        # e.g. 123456789 or 123,456

# Optional: edit "vars" in wrangler.jsonc: TIMEZONE, DIGEST_HOUR, COMMUNITY_LABEL,
# and BOT_USERNAME (without @) so commands addressed to other bots are ignored.

npm run deploy                           # prints https://telepathy.<you>.workers.dev
curl -X POST https://telepathy.<you>.workers.dev/admin/setup \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
# -> registers the webhook (with WEBHOOK_SECRET) and the command menu
```

## 2. Turn on your groups

1. Add the bot to each group **as admin** (needed for join/leave events and admin checks).
2. As an owner (listed in `OWNER_IDS`) who is also a chat admin, send `/enable` in the group.
   Optional visibility: `/enable PUBLIC_APPROVED` or `/enable INTERNAL_RESTRICTED`.
3. Pin the bot's collection notice. Members DM the bot: `/start`, `/ask …`, `/digest on`.

Full history is kept by default. `/retention 365` (in the group) purges older messages daily,
and `/retention 0` returns to keep-all.

## 3. Import past history

Bots only see messages sent after they joined. To add older history:

1. In Telegram Desktop: open the group → ⋮ → **Export chat history** → format **JSON**. Untick
   media to keep the file small.
2. Make sure the group is already enabled (step 2). The import stores nothing for other chats.
3. Convert and load:
   ```bash
   npm run import -- ~/Downloads/ChatExport/result.json      # writes import/part-001.sql, ...
   npx wrangler d1 execute telepathy --remote --file import/part-001.sql
   ```
   **Free plan: one file per day.** Each file holds 15,000 messages, about 75,000 of the
   100,000 daily D1 writes, which leaves room for live traffic. Re-running a file is safe.
   Members who used `/forget_me` are skipped, and names are never stored.

## 4. Free-plan capacity (measured in tests)

| Resource | Free limit | Telepathy usage | What it means |
|---|---|---|---|
| D1 writes | 100,000 rows/day | **≈5 per message** (live or imported) | ≈20,000 new messages/day; imports at 15,000/day |
| D1 reads | 5,000,000 rows/day | ≈4 per matching message per search | thousands of searches/day for a typical community |
| D1 size | 500 MB per database | text stored once + search index | my estimate: on the order of 1 million average messages; check with `npx wrangler d1 info telepathy` |
| Worker requests | 100,000/day | 1 per Telegram update + 288 cron runs | ≈99,000 updates/day |
| Worker CPU | 10 ms per request | short handlers, no SDK, D1 waits don't count | watch `wrangler tail` for "exceeded CPU" |
| Bundle | 3 MB | **114 KiB** | fine |

Limits come from Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits)
and [D1 limits](https://developers.cloudflare.com/d1/platform/limits) pages (checked 2026-10-23;
they can change). If you outgrow them, Workers Paid starts at $5/month and raises D1 to 10 GB per
database. No code changes are needed.

## 5. Daily operation

| When | What happens |
|---|---|
| every webhook | message stored (enabled groups only); replies to commands; intro messages sent at once |
| every 5 min (cron) | stuck sends → uncertain; intro expiry (72 h invite, 14 d request); 24 h reminders; next batch of digests; leftover sends |
| from `DIGEST_HOUR` local | digest to members who ran `/digest on`, about 30 per run, built only from groups each person can read |
| once a day | retention purge, only for groups with `/retention N` |

Owner commands (DM the bot): `/status`, `/sources`, `/uncertain`.
HTTP (needs `Authorization: Bearer <ADMIN_TOKEN>`): `GET /admin/status`, `POST /admin/cron`
(run the scheduled work now), `POST /admin/setup`.

Logs: `npx wrangler tail`. Message contents are never logged.

## 6. Backups and restore

- **Point-in-time restore (built into D1):** `npx wrangler d1 time-travel info telepathy`, then
  `npx wrangler d1 time-travel restore telepathy --timestamp=<ISO time>`. Check Cloudflare's
  docs for how far back your plan allows.
- **Off-Cloudflare copy (weekly is a good default):**
  ```bash
  npx wrangler d1 export telepathy --remote --output backup-$(date +%F).sql
  age -r <your-age-public-key> -o backup-$(date +%F).sql.age backup-$(date +%F).sql && rm backup-$(date +%F).sql
  ```
  Store the `.age` file somewhere other than Cloudflare. The export contains message text, so
  never commit it.
- **Restore test (monthly):** create a scratch database (`wrangler d1 create telepathy-restore`),
  load the export with `wrangler d1 execute telepathy-restore --remote --file backup.sql`, and
  spot-check row counts.

## 7. Upgrades and rollback

```bash
git pull && cd worker && npm ci && npm test
npm run db:migrate:remote     # forward-only, additive migrations
npm run deploy
```
Roll back code with `npx wrangler rollback`. Migrations are never rolled back. If one ever has
to be undone, use Time Travel to restore the database to just before it.

## 8. Incidents

| Symptom | Action |
|---|---|
| `/status` shows **sends uncertain** | A send's outcome is unknown (timeout or crash). Run `/uncertain` and press Delivered / Not delivered. The bot never resends these on its own. |
| Bot doesn't react at all | `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo` shows the last error. Re-run `POST /admin/setup`. |
| Group messages aren't stored | Privacy mode must be off, the bot must be in the group, and `/enable` must have been sent there. |
| "exceeded CPU" in `wrangler tail` | Usually a very large document; only text files ≤ 512 KB are parsed. Report it with the time. Nothing is lost, because Telegram retries. |
| D1 daily limit reached | Writes pause until 00:00 UTC. Telegram retries webhooks for a while, but long outages can drop updates, so pause imports first. |
| Bot token leaked | BotFather `/revoke` → `npx wrangler secret put BOT_TOKEN` → `POST /admin/setup`. |
| Group upgraded to a supergroup | Handled automatically: the bot follows Telegram's migration notice to the new chat id. Check `/sources`. |
| A member asks for deletion | They use `/forget_me` themselves, or reply `/forget` to one message. |

## 9. What's different from the Python version

| Python v1 (Linux host) | Worker v2 (this runbook) |
|---|---|
| long polling | webhook with secret token |
| SQLite file on disk | Cloudflare D1 (SQLite) |
| PDF/DOCX/PPTX parsing | text formats only (txt, md, html, csv, vtt, srt ≤ 512 KB); other files are just referenced |
| nightly backup file | D1 Time Travel + `wrangler d1 export` |
| in-process worker loop | cron trigger every 5 minutes |

The Python implementation in `src/telepathy/` stays in the repo as the self-hosted alternative.
