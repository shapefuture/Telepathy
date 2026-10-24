# ADR-005: Continuity identity, consent log and portability

**Status:** accepted for the prototype (2026-10-24). **Context:** `docs/CONTINUITY_PLAN_RU.md`.

- **Six separate records** (plan §2): community identity, person, follow intent per purpose,
  membership attestation, destination manifest, delivery registration. None implies another:
  losing membership doesn't cancel a news follow; following doesn't reveal a contact.
- **TUF-style identity.** Offline root keys (threshold) delegate to an online key in the Worker.
  The online key may sign address lists but not move the primary address. Root updates need the
  previous threshold. Clients pin the root.
- **Consent as a log.** `subscription_ops` with per-person sequence numbers; state = the highest
  sequence per topic. Imports keep sequences, so restore/replay order doesn't matter. Tombstones
  (`suppressions`) are checked at send time.
- **Independent login** by email code (HMAC-stored, 10 min, 5 attempts, 3 per hour) or one-time
  recovery codes. Passkeys are deferred: WebAuthn verification needs CBOR/COSE parsing that doesn't
  fit the free plan's CPU budget comfortably; revisit on Workers Paid.
- **Email via a named processor** (Resend-compatible API) because Cloudflare's `send_email` only
  reaches pre-verified recipients. Off unless configured.
- **Addresses encrypted at rest** (AES-GCM, key derived from `CONTINUITY_KEY`); lookups by HMAC.
- **No automatic enrolment**, no import of chat members, no scraping (plan §12).
