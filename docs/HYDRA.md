# Hydra: running the antifragile reach (P16)

The plan and its reasoning are in [`HYDRA_PLAN.md`](HYDRA_PLAN.md). This page covers what is
built, how to switch each part on, and how to drill it. Everything builds on Continuity
([`CONTINUITY.md`](CONTINUITY.md)) and stays off until `CONTINUITY_KEY` is set.

**Rule of the system:** losing one path must never cut a member off, and every lost path should
leave the member with two new independent ones. Members add paths themselves; nothing is turned on
for anyone.

## 1. What exists

| Phase | Built | Where |
|---|---|---|
| H0 head model | failure domains (incl. MX lookup and same-company parents), registry, independent paths per person, k-path coverage, hydra index, regrowth ratio | `worker/src/hydra/domains.ts`, `graph.ts`, `/hydra` |
| H1 delivery heads | Web Push (VAPID + RFC 8291), ntfy, Matrix DM, SMS (Twilio), second email provider with failover and circuit breaker, buddy mesh, signed notices as JSON/Atom/iCal, Mastodon/Bluesky/Archive announcers | `deliver.ts`, `webpush.ts`, `heads.ts`, `notices.ts`, `continuity/email.ts` |
| H2 login heads | passport id, authenticator (TOTP), device key (ECDSA P-256, non-extractable in the browser), code over any healthy head | `login.ts`, portal |
| H3 regrowth | head and domain health from deliveries, bounces/deliveries webhooks and canaries; incidents; "add two heads" invitations over surviving heads; club playbook (automatic or proposed); reviews | `health.ts`, `regrow.ts` |
| H4 multi-homing | nightly escrow encrypted to X25519 recipients (S3-compatible buckets, optional R2), Shamir split of any secret, Python standby node | `escrow.ts`, `shamir.ts`, `src/telepathy/federation/hydra.py`, `scripts/hydra.mjs` |
| H5 member-held proof | countersigned follow receipts kept on the device and in the export; re-presentation to a fresh node; guardians (k of n, 24 h to cancel) | `receipts.ts`, `login.ts` |
| H6 anchors and gossip | anchor record (root key ids + manifest hash + primary) at `/.well-known/nexus-anchor.txt` and in the public feeds; partner gossip (≤ 3 hops, re-verified at every hop); printed recovery card with QR; static mirror builder | `notices.ts`, `fed.ts`, `portal.ts`, `scripts/hydra.mjs mirror` |
| H7 sealed relocation + chaos | owners' heartbeat; sealed relocation split k-of-n among partners, released only after silence + 3 days down + k confirmations; head-off drills with cohorts; drill calendar reminders | `fed.ts`, `chaos.ts` |
| H8 conformance | SDK `contracts/sdk/hydra.mjs`, vectors `contracts/test-vectors/hydra-v1.json`, Python parity | tests in `worker/test/hydra.test.ts`, `tests/test_hydra_conformance.py` |

**Not built:** passkeys (WebAuthn needs CBOR/COSE parsing; deferred as in ADR-005); Nostr signing
inside the Worker (no secp256k1 in WebCrypto; `npm run hydra -- anchors` prints the text for your
own Nostr client); WhatsApp; a second Cloudflare account and a non-Cloudflare *live* node (the
Python standby restores and sends; it is not a full portal).

## 2. Switching heads on

All optional. Each one you add is another place members can be reached and another processor to
name in your privacy notice (`docs/PRIVACY.md` §Hydra).

| Head | Set | Cost |
|---|---|---|
| ntfy | `NTFY_SERVERS` = `https://ntfy.sh` and/or your own server (comma-separated) | free |
| Web Push | `npm run hydra -- vapid` → `VAPID_PUBLIC_KEY` (var), `VAPID_PRIVATE_KEY` (secret), `VAPID_SUBJECT` (`mailto:` or URL) | free |
| Matrix | a bot account; `MATRIX_HOMESERVER` (var), `MATRIX_ACCESS_TOKEN` (secret) | free |
| 2nd email | `EMAIL_B_PROVIDER` = `postmark` (or `resend` at a different company than A), `EMAIL_B_API_KEY` (secret), `EMAIL_B_FROM` | free tier |
| Mailbox feedback | register `https://<worker>/hydra/mail-events?t=<EMAIL_WEBHOOK_SECRET>` for delivered + bounced events at your provider | free |
| SMS | `SMS_PROVIDER=twilio`, `SMS_ACCOUNT_SID`, `SMS_AUTH_TOKEN` (secret), `SMS_FROM` | paid |
| Public announcements | `MASTODON_URL` + `MASTODON_TOKEN`, `BLUESKY_HANDLE` + `BLUESKY_APP_PASSWORD`, `ARCHIVE_ANCHOR=true` | free |
| Escrow | `npm run hydra -- escrow-keys` per recipient → `ESCROW_RECIPIENTS` (comma list of public keys); `ESCROW_TARGETS` JSON with secret names; optional `ESCROW_R2` binding | free tier |

`ESCROW_TARGETS` example (the key values themselves are secrets you add with `wrangler secret put`):

```json
[{"name":"b2","url":"https://s3.eu-central-003.backblazeb2.com/club-escrow","region":"eu-central-003","keyIdSecret":"B2_KEY_ID","secretSecret":"B2_SECRET"}]
```

Then add **canaries** (daily probes that catch silent failure):

```
/hydra canary add ntfy https://ntfy.sh/<a private test topic>
/hydra canary add mirror https://<your mirror>
/hydra canary add email <a seed inbox at another provider>
/hydra canary add telegram
/hydra canary add matrix
```

And tell the system what fails together that it can't see itself:

```
/hydra domain ntfy:ntfy.club.example parents cloud:hetzner
/hydra domain matrix:matrix.club.example parents cloud:hetzner
```

## 3. Reading `/hydra`

- **≥2 / ≥3 independent paths**: people following critical notices with that many heads that share
  no failure domain. Two Gmail addresses are one; Gmail and Chrome push share `org:google`.
- **Hydra index**: the fewest domains whose joint failure cuts off more than 10%. Target ≥ 3. The
  "weakest" line names them; that is where to grow next.
- **Regrowth**: per incident or drill, new independent heads ÷ heads lost (members' new heads within
  14 days + club steps marked done). Target ≥ 2.
- **Playbook**: steps that run without you (`email_failover`, `public_notice`). Everything else is
  proposed; mark it with `/hydra done <action> <new-domain>` or `/hydra decline <action>`.

## 4. Members

In the portal (`/portal`), members see how many independent paths they have and two concrete
suggestions that don't share a domain with what they have. They can add browser notifications,
ntfy, Matrix, SMS or another email; switch on an authenticator or "remember this device"; print a
**recovery card** (passport id, a fresh one-time code, a QR to the portal, the club key ids); pair
with a **buddy**; and choose **guardians**. Their device keeps signed **receipts** of every choice;
"Restore my choices from this device" re-presents them to a node that lost its data.

## 5. When something breaks

1. Nothing to do for routing: critical notices already go to every verified head.
2. `/hydra` shows the incident. Affected members are invited, over a head that still works, to add
   two heads. Do the proposed club steps.
3. Afterwards: `/hydra review <id> <cause> <what we learned>`. Suggestions steer away from domains
   hit in the last 180 days.
4. Telegram gone: the `public_notice` step publishes a signed notice to the feeds and accounts;
   send `/alert incident public …` from the portal (two login methods) for members.
5. Cloudflare or the Worker gone: see §7.

## 6. Drills (H7)

| When | What | Command |
|---|---|---|
| monthly | one channel off for a random cohort | `/drill start head_off email 20` … `/drill end` |
| quarterly | Telegram unavailable, run from the portal | `/drill start telegram_down` |
| yearly | Telepathy unavailable: standby restore (§7) | then `/hydra drilled nexus_down` |
| yearly | root custodian rotation | `npm run identity -- root-next …`, then `/hydra drilled custodians` |

The cron reminds owners monthly about overdue drills. Drills never start on their own.
`/drill end` reports the share of the cohort that confirmed (target ≥ 90%) and the regrowth ratio.

## 7. Telepathy or Cloudflare unavailable

**Standby node (any VPS, no Cloudflare):**

```bash
uv sync
python -m telepathy.federation.hydra standby-init escrow-2026-10-24.json x25519.key root.json standby.db
python -m telepathy.federation.hydra standby-notify standby.db "We moved" "New address: https://…"          # counts only
SMTP_HOST=… SMTP_FROM=… python -m telepathy.federation.hydra standby-notify standby.db "We moved" "…" --send
```

It verifies the export against your pinned root, keeps only people following critical notices,
skips suppressed addresses, and reaches email and ntfy heads.

**Lost `CONTINUITY_KEY`:** custodians each hold one share from
`npm run hydra -- shamir-split <key> 5 3`; any three rebuild it (`shamir-combine`, in Node or
Python).

**Mirrors:** `npm run hydra -- mirror https://<worker> ./mirror`, upload to any static host, then
`/destinations add web https://<mirror>`. The mirror verifies signatures in the browser.

**Anchors:** `npm run hydra -- anchors https://<worker>` prints a DNS TXT record and post text.
Any one surviving copy lets a client check that an address list is the real one.

## 8. Sealed relocation (dead man's switch)

1. Custodians sign a relocation to a rescue address that expires in about a year:
   `npm run identity -- relocate manifest.json https://rescue.example "sealed"`, then each signs.
2. `npm run hydra -- seal next.json 2 30 https://partner-b,https://partner-c > seal.json`
   and `POST /admin/hydra/seal` with it. Each partner receives one share; none can open it alone.
3. Partners check daily. A partner releases its share only if **owners have been silent for 30 days**
   (signed heartbeat at `/.well-known/nexus-heartbeat.json`, refreshed by any owner command)
   **and** the primary has been **down on 3 separate days**. When any partner holds k shares it
   decrypts, verifies against its pinned root, relays at `/v1/relay`, and gossips it on.
4. Re-seal after a root rotation and yearly. Designated partners must also be partners of each other.

## 9. Honest limits

- Web Push, ntfy and Matrix get the notice text (ntfy and Matrix in clear to their operators).
  Critical notices are written to be public-safe.
- Push and email canaries prove a provider accepted a message, not that it reached the inbox; the
  mail-events webhook closes most of that gap.
- The hydra index looks at the 24 most common domains, up to four failing together. Correlations
  you don't register stay invisible.
- Receipts presented to a fresh node bring back the choices the device kept. A device that kept only
  an old follow would bring back that follow. Restoring the escrow's tombstones (§7) prevents this.
- Guardians are people: the 24-hour cancel window and the warning to the member's own heads are
  the protection against social engineering.
