# ADR-001: One Worker per organization; federation between nodes

**Status:** accepted for the prototype (2026-10-24). **Context:** plan §A.3 items 1–2, §F.2.

## Decision

Each organization runs its **own** Worker and D1 database (a "node"). The `organizations`
table holds exactly one `home` row plus allowlisted **partner** nodes, which are references
(id, endpoint, public key, allowed job categories) and never hold the partner's members or data.
Every `sources` row carries `org_id='home'`.

Cross-organization work happens only through signed messages between nodes (ADR-003).

## Why

- Tenant isolation is structural: there is no query that could read another community's
  passages, because they are in another database. The negative tests in plan §J.2 ("tenant
  matrix") reduce to: inbound messages can't read anything, and outbound messages carry only the
  envelope fields (`worker/test/federation.test.ts`).
- Free plan: one D1 database per community fits D1 limits; one shared database would hit the
  500 MB / 100k-writes limits for everyone at once.
- Exit (I14) is trivial: a community stops its Worker or suspends partners.

## Consequences

- A managed multi-tenant host (E1) means running several Workers, not adding `org_id` to every
  query. If that ever becomes too costly, revisit with Durable Objects per tenant.
- Capacity reservation is atomic inside one D1 transaction (`reserve` in
  `worker/src/assist/capacity.ts`); no cross-node locking is needed because a slot belongs to one
  node.
- Legacy `needs`/`intros` stay as they are; missions are new tables (`0005_assistance.sql`).
