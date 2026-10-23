# Hosting: can this run on Cloudflare for free?

> **Decision (2026-10-23): Option C.** Built in `worker/`. Deploy with
> [`DEPLOY_CLOUDFLARE.md`](DEPLOY_CLOUDFLARE.md). The v2 schema stores text once, so measured
> usage is about 5 D1 writes per message, better than the estimates below, which assumed the
> Python schema.

**Short answer:** partly. The free Cloudflare tier can run the bot's always-on edge and a small
community's recent history. It cannot run the current Python bot, cannot hold full history for a
large group, and cannot run local semantic search. Two working setups are below.

## Free tier limits (checked 2026-10-23)

| Item | Free | Source and confidence |
|---|---|---|
| Workers requests | 100,000 / day; burst 1,000 / min | [Workers limits](https://developers.cloudflare.com/workers/platform/limits) (official, via search) |
| Workers CPU per request | **10 ms** | Official limits page per search. One blog says 30 ms; I treat 10 ms as correct until verified. |
| Subrequests per request | 50 | Same page |
| D1 rows **written** / day | **100,000** | [D1 free tier summary](https://freetier.co/articles/cloudflare-d1-free-tier-limits-pricing-and-alternatives) (secondary) |
| D1 rows read / day | 5,000,000 | same (secondary) |
| D1 max size **per database** | **500 MB** | [D1 limits](https://developers.cloudflare.com/d1/platform/limits) (official, via search) |
| D1 total storage per account | 5 GB | same |
| Paid plan minimum | $5 / month, includes 10M Worker requests; D1 per database up to 10 GB | Workers pricing (official, via search). Check the current D1 write allowance before deciding. |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits).

## What that means for you

**Full history on free D1 is the hard limit.**

- **Import speed.** Each message currently becomes about 4 rows (raw event, message, excerpt,
  search row). 100,000 messages is about 400,000 writes. At 100,000 writes a day, that is roughly
  **four days** of free quota for one import. A large group takes longer.
- **Storage.** The same text is stored about 4 times (raw JSON, message body, excerpt body,
  search index), plus index overhead. My estimate is **about 800 bytes per message**. That gives
  roughly **500,000–700,000 messages** before the 500 MB per-database cap. Measure this with the
  real export before relying on it.
- **Fix that helps both limits:** stop storing the text in `raw_events` (keep only hashes and IDs),
  and do the import from your own machine in batches. This is a small change I can make.

**Compute.** A Worker gets 10 ms of CPU per request. Database waiting does not count, so a
webhook that does one or two D1 queries fits. The Python code cannot run there. Fuzzy correction
would have to be ported to JavaScript, which is possible (SymSpell has JavaScript versions).

**Long polling is out.** Workers can't hold a long-poll connection. The bot must switch to Telegram
**webhooks**.

**Embeddings are out.** Local models are too heavy for 10 ms. Hosted embeddings (Workers AI,
Vectorize) send community text to Cloudflare, which the constitution forbids without approval.

## Options

### Option A: Linux VPS, long polling (fastest, nothing to port)
The code is ready today: systemd unit, Docker image, backups, and the full test suite pass.
Full history, local semantic search later, no per-database size cap. Cost: a small VPS (a few
euros or dollars a month, check your provider).

### Option B: Cloudflare as the free edge, VPS as the core (recommended if you want Cloudflare)
- A Cloudflare Worker (free tier, well inside 100k requests/day) receives Telegram webhooks,
  checks Telegram's secret token, rate-limits, and forwards each update to the VPS.
- The VPS runs the existing Python bot in webhook mode, behind a Cloudflare Tunnel (free, verify
  current terms) or a firewall allowlist, so it has no open port to the public internet.
- Cloudflare Cron Triggers can ping the VPS for the daily digest, or the VPS keeps its own timer.
- Full history, semantic search, and the code stay as they are. Cloudflare only adds an edge.
- Work needed: webhook mode in `bot/app.py` (aiogram supports it), a small Worker that forwards
  updates, and a shared-secret check on the VPS. Roughly a day of work. I can build it.

### Option C: Everything on Cloudflare (free, small community only)
Port the bot to TypeScript with grammY (it supports Workers), store data in D1, run digests with
Cron Triggers, and import history from your machine in batches. Limits: a few hundred thousand
messages at most, four days per import on free writes, no local semantic search, and a full
rewrite of about 6,000 lines plus tests. Only pick this if you accept those limits.

## Recommendation

Start with **Option A** to get to production fastest with full history. Move to **Option B** when
you want Cloudflare in front for webhooks and rate limiting. Choose **Option C** only for a small,
recent-history community that will never need semantic search.
