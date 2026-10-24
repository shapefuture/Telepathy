# Deploy runbook: Cloudflare Workers (free plan)

Telepathy v2 runs as one Cloudflare Worker (`worker/`) with a D1 database. Telegram sends updates
to the Worker by webhook; a cron trigger every minute handles sends, partner messages, expiries,
reminders, the daily digest and optional retention. There is no server to run.

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

# Optional: edit "vars" in wrangler.jsonc: DEFAULT_LANG ("ru" by default; members can still
# switch with /language en), TIMEZONE, DIGEST_HOUR, COMMUNITY_LABEL,
# and BOT_USERNAME (without @). It lets members ask by @mention in groups and makes the
# bot ignore commands addressed to other bots.

npm run deploy                           # prints https://telepathy.<you>.workers.dev
curl -X POST https://telepathy.<you>.workers.dev/admin/setup \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
# -> registers the webhook (with WEBHOOK_SECRET) and the command menu
```

## 2. Turn on your groups

1. Add the bot to each group **as admin** (needed for join/leave events and admin checks).
2. As an owner (listed in `OWNER_IDS`) who is also a chat admin, send `/enable` in the group.
   Optional visibility: `/enable PUBLIC_APPROVED` or `/enable INTERNAL_RESTRICTED`.
3. Pin the bot's collection notice. Members can `/ask …` right in the group (answers come only
   from that group) or DM the bot for everything else: `/start`, `/ask`, `/digest on`, `/language ru`.
4. Optional: `/hints on` in a group. When someone asks a question that group already answered,
   the bot replies once with a link to the earlier thread (at most one hint per 10 minutes per
   group). It's off by default because the bot then speaks without being asked.
5. **Welcome** (on by default; `/welcome off` per group): people who join get a short intro from
   the bot. It's private when Telegram allows it: if they've opened the bot before, or if the group
   uses join requests ("approve new members"). Otherwise a message in the group tags them with a
   "Start" button and deletes itself after 2 minutes. After this update, re-run `POST /admin/setup`
   once so Telegram sends join requests to the bot.
6. Optional: `/routing on` in a group. Questions with no reply after 4 hours go privately to at
   most 2 opted-in experts who can read that group (max 3 pings per expert per day; experts stop
   them with `/pings off`). Also off by default.
7. Moderation (owner + chat admin, reply to a message): `/canonical` marks the best answer on a
   topic, and older canonical answers on it are labelled outdated. `/notevent` hides a wrong event.
8. Members: `/catchup [12h|3d]`, `/events` (with an .ics file), search filters
   `in:<group> since:<date|7d> has:file`, and the **Mini App** (chat menu button set by
   `/admin/setup`; set `PUBLIC_URL` in `wrangler.jsonc` to also enable the `/app` button).
   The app has tabs for Home (search, catch-up, counters, next events), Ask (filters, sources,
   feedback), Requests (new request, local answer, partner offers, intro invitations, ratings),
   Events, Me (settings, skills, privacy, delete my data) and, for owners, Desk (requests,
   partner requests, offers, unserved needs, ledger, health). Optional deep links: create a Mini
   App in BotFather (`/newapp`, URL `https://<worker>/app`); then `t.me/<bot>/<app>?startapp=help`
   opens a new request, and `ask`, `requests`, `events`, `profile`, `desk` open those tabs.

Full history is kept by default. `/retention 365` (in the group) purges older messages daily,
and `/retention 0` returns to keep-all.

## 3. Import past history

Bots only see messages sent after they joined. There are two ways to add older history.

**Automatic (recommended): fetch it with your own account.** This needs no export file. It runs
on your computer, and your login and the messages stay there.

1. Get `api_id` and `api_hash` at <https://my.telegram.org> → *API development tools*.
2. Enable the group (step 2), then run:
   ```bash
   export TG_API_ID=... TG_API_HASH=...
   npm run backfill -- --chat @yourgroup        # first time: your phone number + login code
   npm run import -- backfill/chat123.json --chat-id -100123   # the line it prints
   npx wrangler d1 execute telepathy --remote --file import/part-001.sql
   ```
3. Run `npm run backfill -- --chat @yourgroup` again any time. It fetches only new messages
   since the last run.

Your account must be a member of the group and able to see its history. Keep
`~/.telepathy-backfill.session` private: it is a login to your Telegram account. Don't commit it
or upload it anywhere.

**Manual: Telegram Desktop export.**

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

## 4. Optional: AI summaries

See [AI.md](AI.md). Workers AI writes short summaries on top of `/ask` answers by default; add `OLLAMA_API_KEY` to use Beam first, or set `WORKERS_AI_MODEL` to `off` to turn the backup off.

## 5. Free-plan capacity (measured in tests)

| Resource | Free limit | Telepathy usage | What it means |
|---|---|---|---|
| D1 writes | 100,000 rows/day | **≈5 per message** (live or imported) | ≈20,000 new messages/day; imports at 15,000/day |
| D1 reads | 5,000,000 rows/day | ≈4 per matching message per search | thousands of searches/day for a typical community |
| D1 size | 500 MB per database | text stored once + search index | my estimate: on the order of 1 million average messages; check with `npx wrangler d1 info telepathy` |
| Worker requests | 100,000/day | 1 per Telegram update + 1,440 cron runs | ≈98,500 updates/day |
| Worker CPU | 10 ms per request | short handlers, no SDK, D1 waits don't count | watch `wrangler tail` for "exceeded CPU" |
| Bundle | 3 MB | **≈300 KiB (71 KiB gzip)** | fine |

Limits come from Cloudflare's [Workers limits](https://developers.cloudflare.com/workers/platform/limits)
and [D1 limits](https://developers.cloudflare.com/d1/platform/limits) pages (checked 2026-10-23;
they can change). If you outgrow them, Workers Paid starts at $5/month and raises D1 to 10 GB per
database. No code changes are needed.

## 6. Daily operation

| When | What happens |
|---|---|
| every webhook | message stored (enabled groups only); replies to commands; intro messages sent at once |
| every minute (cron) | stuck sends → uncertain; intro and mission expiry; 24 h reminders; next batch of digests; partner messages (≤5); leftover sends (≤36) |
| from `DIGEST_HOUR` local | digest to members who ran `/digest on`, about 30 per run, built only from groups each person can read |
| once a day | retention purge, only for groups with `/retention N` |

Owner commands (DM the bot): `/status`, `/sources`, `/uncertain`.
HTTP (needs `Authorization: Bearer <ADMIN_TOKEN>`): `GET /admin/status`, `POST /admin/cron`
(run the scheduled work now), `POST /admin/setup`.

Logs: `npx wrangler tail`. Message contents are never logged.

## 7. Backups and restore

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

## 8. Upgrades and rollback

```bash
git pull && cd worker && npm ci && npm test
npm run db:migrate:remote     # forward-only, additive migrations
npm run deploy
```
Roll back code with `npx wrangler rollback`. Migrations are never rolled back. If one ever has
to be undone, use Time Travel to restore the database to just before it.

## 9. Incidents

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

## 10. GitHub Actions (optional) and running without it

Automatic deploys, weekly encrypted backups and PDF/DOCX/PPTX parsing can run on GitHub's
runners. Each is off until you set its variable. Every one of them also has a no-Actions path
(Cloudflare Workers Builds, `scripts/backup-local.sh`, `scripts/offload-local.sh`,
`scripts/check.sh`). See [`GITHUB_ACTIONS.md`](GITHUB_ACTIONS.md#if-your-actions-minutes-run-out).

## 11. Assistance desk and partner gateway

Members ask with `/help <need>`; owners work the desk with `/desk`, publish capacity with
`/offer`, and connect partner communities with `/partner`. All of it works locally with
federation off. To connect partners, see [`OPERATOR_GUIDE.md`](OPERATOR_GUIDE.md):

```bash
npm run fed:keys                                   # prints a key pair to your terminal
npx wrangler secret put FEDERATION_PRIVATE_KEY     # paste the private key
# wrangler.jsonc vars: FEDERATION_ENABLED "true", PUBLIC_URL, FEDERATION_PUBLIC_KEY
npm run db:migrate:remote && npm run deploy
```

## 12. What's different from the Python version

| Python v1 (Linux host) | Worker v2 (this runbook) |
|---|---|
| long polling | webhook with secret token |
| SQLite file on disk | Cloudflare D1 (SQLite) |
| PDF/DOCX/PPTX parsing | text formats in the Worker (≤ 512 KB); PDF/DOCX/PPTX via the opt-in GitHub Actions job |
| nightly backup file | D1 Time Travel + weekly age-encrypted export (GitHub Actions or by hand) |
| in-process worker loop | cron trigger every minute |

The Python implementation in `src/telepathy/` stays in the repo as the self-hosted alternative.
