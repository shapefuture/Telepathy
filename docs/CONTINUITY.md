# Continuity: keep your community reachable without one platform

Telepathy can keep a **verified, consented, independent** link between your club and its members,
so that losing the Telegram group, the bot, the domain or Telepathy itself doesn't mean losing
the people. This is the implementation of `docs/CONTINUITY_PLAN_RU.md` (CONT-0..10).

**What it does not do.** It doesn't move people who never enrolled. A stored Telegram id gives no
right to email anyone. It doesn't get around platform rules. It isn't "100% protected": the
dashboard only counts what was verified.

Hydra (P16) adds more independent paths, logins and recovery on top of this: see
[`HYDRA.md`](HYDRA.md).

## Pieces

| Piece | Where | What it guarantees |
|---|---|---|
| Club identity (CONT-1) | `/.well-known/nexus-community.json` | Root keys (offline, 2 of 3) delegate to an online key. The online key signs the address list; **moving the primary address needs root signatures**. Versions only go up; lists expire after 30 days. |
| Passport (CONT-2) | Mini App → Passport, `/passport` | Members opt in themselves; nothing is pre-selected. |
| Independent login (CONT-3) | `/portal` | Email code or one-time recovery code; works without Telegram. "Protected" only after real verification. |
| Purposes (CONT-4) | Passport / portal | Critical notices, events, request updates, news, community offers, partner offers: each separate. Changes are a versioned log, so **a restore never turns an unsubscribe back on**. |
| Export / import (CONT-5) | `GET/POST /admin/continuity/export|import`; `python -m telepathy.federation.continuity` | Signed bundle of verified addresses, follow logs, memberships, tombstones; no chat text or Telegram ids. Rebuildable **without Telepathy** (Python CLI). |
| Alerts (CONT-6) | `/alert`, portal (owners, two factors) | Only to people who chose critical notices, over verified channels, once each, at most 1 a day; relocation alerts only after a root-signed relocation. |
| Membership pass (CONT-7) | Passport → pass for a partner | Signed, 7 days, one partner, pseudonymous; revocation check at `/v1/attestations/{id}/status`. |
| Rescue relay (CONT-8) | `POST /v1/notices`, `GET /v1/relay` | Partners publish your verified relocation; nothing about your members travels. |
| Drills and metrics (CONT-9) | `/drill`, `/continuity` | Measures confirmations, not queued messages. |
| SDK and vectors (CONT-10) | `contracts/` | Any implementation can verify manifests, passes and exports. |

## Set up (once, about 30 minutes)

1. **Secrets.** `openssl rand -base64 32 | npx wrangler secret put CONTINUITY_KEY`. Keep a copy
   offline; without it, stored addresses can't be decrypted.
2. **Club identity, on an offline machine:**
   ```bash
   node worker/scripts/identity.mjs init my-club https://t.me/my_club 3 2
   ```
   Give `identity-out/custodian-1..3.key` to three different people and keep them offline. Put
   `online.key` into `npx wrangler secret put IDENTITY_ONLINE_KEY`, and the printed public key
   into `IDENTITY_ONLINE_PUBLIC_KEY` in `wrangler.jsonc`. Deploy, then upload:
   ```bash
   curl -X POST $WORKER/admin/identity/root     -H "Authorization: Bearer $ADMIN_TOKEN" --data @identity-out/root.json
   curl -X POST $WORKER/admin/identity/manifest -H "Authorization: Bearer $ADMIN_TOKEN" --data @identity-out/manifest.json
   ```
   Publish the root key ids somewhere members already trust (pinned post, website).
3. **Email (optional but needed for "protected").** Pick a provider, set `EMAIL_PROVIDER`
   `"resend"`, `EMAIL_FROM`, and the `EMAIL_API_KEY` secret. Name the provider in your privacy
   notice: it receives addresses and message text when it sends.
4. Add backups: `/destinations add web https://my-club.example`,
   `/destinations add rss https://my-club.example/feed.xml`. Run `/destinations resign` at
   least monthly (lists expire after 30 days).
5. Invite members: post `/passport` in your channel. Check `/continuity` weekly.

## Flow B: Telegram is unavailable

1. Log in at `https://<worker>/portal` with your email code **and** a recovery code (two
   factors within 15 minutes).
2. If the official address changes: on the offline machine run
   `node worker/scripts/identity.mjs relocate current-manifest.json <new-url> "<reason>" > next.json`;
   two custodians each run `SIGN_KEY=… node worker/scripts/identity.mjs sign next.json`; upload
   it to `/admin/identity/manifest`. Partners receive and relay it automatically.
3. Send the notice from the portal ("Send relocation notice"). It reaches only people who chose
   critical notices, over verified channels.

## Flow C: Telepathy (or Cloudflare) is unavailable

Keep a recent export off Cloudflare: `curl $WORKER/admin/continuity/export -H … > export.json`,
then encrypt it with `age`, like `scripts/backup-local.sh` does. With only that file, the pinned
root and Python:
```bash
python -m telepathy.federation.continuity restore root.json export.json   # who wants what
```
A new Telepathy install imports it with `POST /admin/continuity/import`. New email providers
may require people to confirm again; we can't promise seamless delivery without a prepared second
provider.

## Flow D: restoring an old database

D1 Time Travel brings back old rows, including follows that were later withdrawn. After any
restore, **import the newest export**: each person's operations keep their sequence numbers, so
newer unsubscribes win, and tombstones only accumulate. Delivery checks tombstones again at send
time.

## Recovery drills (CONT-9)

`/drill start telegram_down` sends a clearly marked drill to people who chose critical notices,
with a confirm link. `/drill end` reports `confirmed / invited`: a measured recovery rate, not a
count of queued messages. Run one per quarter.

## Metrics (`/continuity`, `GET /admin/continuity/metrics`)

IER (independent login / members with group access) · VAR (verified email / following critical) ·
RE (recovery-eligible / enrolled) · RDS (drill confirmations / invited) · PI (unverified
"protected" claims, must be 0). Telegram group size is never used as reach.

## Honest limits

- People who never enrolled can only be invited again through channels you still control.
- A stolen online key can add *backup* addresses until you rotate it (`root-next`); it can't
  move the primary address.
- If nobody pinned your root beforehand, nobody can verify your new address automatically.
- Tombstones use an unkeyed SHA-256 of the address so they survive moving installs; a leaked
  database could reveal whether a known address unsubscribed.
