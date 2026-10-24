# Hydra: an antifragile path between a community and its members

**Status:** built in the prototype (2026-10-24), not yet drilled with a real club. Builds on
Continuity (P15, `docs/CONTINUITY.md`). What exists and how to run it: [`HYDRA.md`](HYDRA.md).
"*exists*" below marks what predates this plan.

## 1. The goal in one sentence

Losing any one path (Telegram, email, a domain, a host, a key, an operator, Telepathy itself)
must never cut the link. Each loss must also **make the system grow more independent paths than
it lost.** Cut one head, two grow back.

Resilience (surviving a hit) isn't enough. Antifragility here means three things:

1. **Redundancy that is actually independent.** Two Gmail addresses are one head, and two Workers
   on one Cloudflare account are one head. The plan counts *failure domains*, not channels.
2. **Regrowth triggered by failure.** A blocked path starts a workflow that adds at least two
   replacement paths, for the people affected first.
3. **Learning from hits.** Every outage, real or drilled, feeds a review that changes which
   kinds of path the club grows next.

Boundaries that don't move: every path is consented separately (C23). No evasion of lawful
moderation, and no breaking platform rules. No spam. A path someone withdrew from never regrows
by itself (C25).

## 2. The heads (paths), grouped by failure domain

Each head has a **failure domain**, which says what takes it down together with others, and a
**cost** on the free plan.

### 2.1 Delivery heads: how the club reaches members

| Head | Domain | Push/pull | Cost | Notes |
|---|---|---|---|---|
| Telegram bot DM (*exists*) | Telegram | push | free | first to fall in a Telegram incident |
| Telegram channel + backup channel | Telegram | push | free | same domain as the bot: counts once |
| Email, provider A (*exists*) | provider A + recipient's mailbox host | push | free tier | |
| Email, provider B (different company, different sending domain) | provider B | push | free tier | automatic failover on errors or bounces |
| **Web Push** (VAPID, from the portal origin) | browser vendor + our origin | push | free | needs ECDSA P-256 and aes128gcm in WebCrypto; subscriptions are tied to one origin, so each mirror origin needs its own |
| **ntfy** topic (public ntfy.sh or self-hosted) | ntfy host | push | free | no account; per-member random topic, end-to-end encrypted payload |
| **Matrix** room + bot | homeserver | push | free | a second group space if Telegram falls; can be self-hosted |
| **RSS/Atom feed** of signed public notices | each mirror host | pull | free | survives any push block; no consent issue (public) |
| **iCal feed** for events and notices | mirror host | pull | free | already in people's calendars |
| Public social accounts (Mastodon/ActivityPub, Bluesky/AT, Nostr): **public announcements only** | each network | pull/push | free | never a private follow graph (plan §12) |
| SMS / WhatsApp Business | carrier / Meta | push | paid | optional; critical notices only |
| **Human relay ("buddy" mesh)** | people | push | free | opt-in pairs forward critical notices by any means they have |
| Printed **recovery card** (QR: root key ids, portal mirrors, personal recovery code) | paper | pull | free | the head nothing online can cut |

### 2.2 Login heads: how a member proves who they are without Telegram

- *Exists:* email code, one-time recovery codes.
- **TOTP authenticator app** (RFC 6238; HMAC-SHA1, cheap in a Worker).
- **Magic link over any verified delivery head** (push, ntfy, Matrix DM), not only email.
- **Passkeys** (WebAuthn), once on Workers Paid or with a slim verifier.
- **Member-held device key:** a non-extractable key pair in the member's browser (WebCrypto +
  IndexedDB). The member signs their own follow receipts (§2.4) and can log in by signing a
  challenge.
- **Social recovery:** k of n guardians the member chose (other members) vouch for a new login.
  Guardians learn nothing except that someone asked.

### 2.3 Hosting heads: where the community can be found

- *Exists:* the primary Worker, partners relaying a signed relocation, `/.well-known` manifest.
- **Second Worker on a different Cloudflare account**, plus a **non-Cloudflare node**: the Python v1
  service on a VPS, Fly.io or Deno Deploy, kept current by encrypted replication of continuity data
  (§2.5).
- **Static portal mirrors** on several unrelated hosts (Cloudflare Pages, Netlify, GitHub Pages,
  IPFS gateway, optional Tor onion). They carry only public material: the signed manifest, the
  notice feed, and the login page pointing at live nodes. They verify everything in the browser
  against the pinned root.
- **Several domains** at different registrars and TLDs, all listed in the signed manifest.
- **Manifest anchors** in independent public places: DNS TXT (root key ids), a pinned Nostr note,
  an AT Protocol post, a commit to a public repository (public manifest only, never community
  data), the Internet Archive. Any copy verifies against the root, so it doesn't matter which
  copy survives.
- **Gossip between partners:** each partner shares the newest verified manifests it knows with its
  other partners. A notice spreads epidemically, with no central relay.

### 2.4 Consent heads: who holds the proof of "I want to hear from you"

- *Exists:* the club database (versioned op log), signed exports, tombstones.
- **Member-held follow receipts:** each follow or unfollow is countersigned by the club's online key
  and stored on the member's device or in their own export. If every club database is lost, members
  can re-present receipts to a new node, which checks them against the root. An unfollow receipt
  with a higher sequence wins, so no one can revive consent by presenting an old receipt.
- **Escrow copies at partners:** export bundles encrypted to the club's own recovery key (age), held
  by 2+ partners who can't read them.

### 2.5 Data and key heads

- **3-2-1 for continuity data:** at least 3 copies, on 2 kinds of storage, 1 outside Cloudflare.
  - automatic nightly encrypted export (age, several recipients) to R2 on a second account;
  - the same to S3-compatible storage (Backblaze B2 or similar);
  - partner escrow.
  - The plaintext never leaves the Worker.
- **CONTINUITY_KEY split** with Shamir (k of n custodians), so losing the operator doesn't lock away
  the addresses.
- **Root custodians spread out:** different people, places and devices. Custodian rotation is
  drilled yearly with `root-next`.
- **Pre-signed sealed relocations ("dead man's switch").** Custodians pre-sign relocation manifests
  to designated backup addresses, each with an expiry. They are released only if:
  - no owner heartbeat for N days **and** the primary path is unreachable, **and**
  - k partners confirm the outage.

  Nobody can trigger it alone.

### 2.6 Operator heads

- At least 2 owners and named deputies, each with independent login heads.
- Incident playbook roles: who declares, who signs, who sends, who talks to members.

## 3. The regrowth engine: what happens when a head is cut

```
canary probe or delivery feedback ──► head health (per head, per failure domain)
        │ failure detected (bounces↑, provider 4xx/5xx, Telegram 403, origin unreachable)
        ▼
classify: one member? one provider? a whole domain (e.g. all Telegram)?
        ▼
1. route around: send over the remaining verified heads (priority by independence)
2. regrow ×2:
   - members who just lost their last-but-one head get a prompt (over any surviving head)
     to add TWO new heads of different domains; the app shows exactly which
   - club-level: propose (or, with pre-approval, start) two replacement paths: a new
     mirror, backup channel, second provider, or new Matrix room
3. record: incident with cause tag → post-incident review → adjust the target mix
```

Rules:

- **Two independent replacements per lost head.** Independence is checked against failure
  domains, not channel names.
- **Pre-approved playbooks:** the club decides in advance which regrowth steps may run on their own
  (new static mirror, switch to provider B, publish to the public feeds), and which need a human
  (new Telegram group, relocation).
- **Never** auto-subscribe anyone to a new head. Regrowth for members is always an invitation over
  heads they already chose.
- **Canaries:** daily synthetic probes per head (seed inboxes at several mailbox hosts, a test
  Telegram account, push and ntfy test subscribers, mirror fetches). They detect silent blocking
  before a real notice is needed.

## 4. Metrics: count heads that don't fall together

- **Head count per member** = number of verified delivery heads in **distinct failure domains**.
- **k-path coverage** = share of enrolled members reachable through ≥ 2 (and ≥ 3) independent
  domains. This becomes the main resilience number, replacing single-path VAR.
- **Hydra index (club)** = the minimum number of failure domains that must fall together before
  more than 10% of enrolled members become unreachable. Computed from the head graph; target ≥ 3.
- **Regrowth ratio** = new independent heads added ÷ heads lost, per incident or drill. Target ≥ 2:
  the literal "two heads" test.
- **Time to reroute** and **time to regrow**: measured in drills.
- Existing metrics stay: IER, RDS, PI = 0. Group size is never reach.

## 5. Chaos practice: making failure routine

- **Monthly head-off drill:** the system disables one head type for a test cohort (for example, no
  email for 24 h). It measures the share still reached, and how many members added a new head when
  prompted.
- **Quarterly domain-off drill:** for example, "Telegram unavailable", run end to end from the portal
  with the two-factor owner login.
- **Yearly**: "Telepathy unavailable". Restore from escrow on the non-Cloudflare node using only the
  Python tools and the pinned root. Also a custodian rotation.
- Each drill writes a short review. Its cause tags feed the regrowth targets (§3).

## 6. Phases, each with an observable gate

| Phase | Builds | Gate (observable) |
|---|---|---|
| **H0 Head model** | failure-domain registry, per-member head graph, k-path coverage, hydra index, regrowth ratio in `/continuity` | metrics computed from verified records only; a test shows two same-provider emails count as one domain |
| **H1 More delivery heads** | Web Push (VAPID), ntfy, signed RSS/Atom + iCal notice feeds, Matrix bot, second email provider with failover | a member reachable by ≥ 3 domains in tests; disabling email still reaches them through the other two |
| **H2 More login heads** | TOTP, magic link over any verified head, member device key; passkeys later | login succeeds with email *and* Telegram disabled |
| **H3 Regrowth engine + canaries** | head health, cause classification, reroute, "add two heads" invitations, pre-approved club playbooks | killing one head in a drill produces ≥ 2 new independent heads for the affected cohort (regrowth ratio ≥ 2) |
| **H4 Hosting and data multi-homing** | second account + non-Cloudflare node with encrypted replication, static mirrors, multi-registrar domains, 3-2-1 escrow, Shamir split of `CONTINUITY_KEY` | full restore on the non-Cloudflare node from escrow with Cloudflare unreachable |
| **H5 Member-held proof** | countersigned follow receipts on devices, re-presentation to a new node, social recovery with guardians | consent restored from receipts alone; an old receipt never overrides a newer unfollow |
| **H6 Anchors and gossip** | manifest anchors (DNS TXT, Nostr, AT, public repo, Archive), partner-to-partner gossip, printed recovery cards | a relocation verified by a client that only reaches one anchor or one partner |
| **H7 Sealed relocation + chaos calendar** | dead man's switch with k-of-n partner confirmation; scheduled drills; post-incident reviews | a drilled "owners gone + primary down" triggers the sealed relocation; nobody can trigger it alone |
| **H8 Conformance** | SDK and vectors for heads, receipts, anchors and gossip; Python parity | a third-party implementation reroutes and verifies with the shared vectors |

**Order:** H0 → H1 → H3 → H2 → H4 → H5 → H6 → H7 → H8. Measure first, add cheap heads, then make
regrowth automatic before the expensive multi-homing.

## 7. Risks and honest limits

- **Cost and the free plan:**
  - Web Push encryption and VAPID signing fit WebCrypto but add CPU per send; batch them in cron.
  - SMS and WhatsApp cost money and stay optional.
  - A second account or host means a second bill once usage grows.
- **Correlated failures hide:** many "different" providers share infrastructure (AWS, Google). The
  failure-domain registry must be maintained by people and reviewed after each incident.
- **Platform rules:** Signal and WhatsApp bots, mass Telegram mirrors and the like can breach terms.
  Only heads used within their rules qualify.
- **More heads, more attack surface:** every head is another place to impersonate the club. That's
  why every notice on every head carries the signed manifest version, and clients verify against
  the pinned root, never against a name or avatar.
- **Privacy:** more heads mean more processors. Each head type is listed in the privacy notice
  before anyone is asked to add it. Public heads carry public notices only.
- **People are the limit:** regrowth is invitations, not enrolment. The design maximizes how easy it
  is to add a second head, and measures whether people actually do.

## 8. Decisive test

Run three drills with a pilot club, each on a different domain (email, Telegram, the hosting
provider). The plan works if, in every drill:

- ≥ 90% of enrolled members are still reached through other heads;
- the regrowth ratio is ≥ 2;
- the time to a verified reroute is < 1 hour.

If a cheaper setup does as well (two email providers plus an RSS feed), keep that and drop the rest.
