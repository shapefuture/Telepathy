# ADR-003: Federation trust model (`nexus.v1`)

**Status:** accepted for the prototype (2026-10-24). **Context:** plan §E.

- **Identity:** a node is its https origin (or an agreed id for manual partners). Keys are
  Ed25519 (WebCrypto in Workers). Partners exchange public keys out of band and an owner adds
  them with `/partner add|manual`. There is no registry or transitive trust yet (E3 is future).
- **Message:** `{schema, type, exchange_id, issuer_org, recipient_org, issued_at, expires_at,
  nonce, body, signature}`; the signature covers canonical JSON of everything else. Schema:
  `contracts/nexus-v1.schema.json`.
- **Receiver checks, in order:** shape and TTL (≤ 15 days, ≤ 5 min clock skew) → route matches
  type and exchange id → `recipient_org` is us → issuer is an active partner with a key →
  signature → nonce not seen (a repeat is a 200 no-op, so senders may retry safely) → policy
  (category allowlist, 50 inquiries/partner/day, non-forwardable, `max_hops: 1`, field allowlist).
- **Delivery:** `fed_outbox` ledger. Retries are safe because receivers deduplicate by nonce;
  after 5 failed attempts a message is `uncertain` for an operator. Partners without an endpoint
  are **manual (E0)**: the signed JSON is shown on `/desk` and the other side loads it with `/fed`.
- **Not adopted yet:** A2A transport, OpenID Federation trust chains, JWS detached signatures,
  key rotation by manifest. The node manifest publishes the current key so rotation is a
  re-`/partner add` on the other side.
