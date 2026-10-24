# ADR-006: Hydra — counting failure domains and regrowing paths

**Status:** accepted for the prototype (2026-10-24). **Context:** `docs/HYDRA_PLAN.md`, `docs/HYDRA.md`.

- **Failure domains, not channels.** Every head stores the domains it depends on (mailbox operator
  from the address or its MX record, push vendor, ntfy/Matrix host, sending provider when only one is
  configured). Built-in parents join the same company (`mail:google` and `push:google` → `org:google`);
  a people-maintained registry adds what code can't see. Metrics count disjoint heads.
- **Hydra index by exhaustive search** over the 24 most used domains, up to 4 at a time, with bitmasks
  and deduplicated head signatures. Computed on demand (owner command, admin endpoint), never in cron.
- **Regrowth is invitation, not enrolment** (C23 holds). An incident queues, per affected person below
  three independent heads, a message over a surviving head naming two kinds in new domains.
- **Health from real traffic first**, canaries second. A rolling one-hour window per domain; "down"
  needs ≥5 failures or ≥80% failures; "up" needs two successes. Mailbox health only from provider
  delivery/bounce webhooks, never from sender errors.
- **Web Push without libraries**: VAPID ES256 and RFC 8291 aes128gcm on WebCrypto.
- **Login without email or Telegram**: TOTP (replay-guarded), browser-held ECDSA device keys,
  codes over any head, guardians (k of n + 24 h + cancel link to the person's own heads). Passkeys
  stay deferred (ADR-005).
- **Escrow format** `nexus.escrow.v1`: X25519 + HKDF-SHA256 + AES-256-GCM per recipient, AES-256-GCM
  payload; decryptable by the SDK and Python with standard libraries. S3 SigV4 upload in the Worker.
- **Sealed relocation** uses Shamir over GF(256) so no single partner can open it; release needs the
  holder's own observation of silence and downtime, and k shares. The manifest inside is still a
  root-threshold relocation verified by the receiver (C24 unchanged).
- **Gossip** forwards only documents that verify; each hop re-verifies; ≤ 3 hops; unpinned orgs are
  stored but flagged.
