# ADR-002: Data classes, disclosure stages and consent records

**Status:** accepted for the prototype (2026-10-24). **Context:** plan §C.2, §D.3.

| Stage | What may be seen | By whom | Grant needed (`consent_grants.action`) |
|---|---|---|---|
| Draft | member's own text | the member | none (confirming creates the next grant) |
| Local | summary, job type | home operators; local search | `local`, audience `home` |
| External discovery | `job`, `summary`, `criteria` only | the listed partners | `external_discovery`, audience = partner ids, fields = those three |
| Reveal | Telegram contact link | one partner, for its helper | `reveal`, audience = that partner, fields `["contact"]` |
| Feedback | useful / not useful | home operators (aggregate) | given by pressing the button |

Every grant binds `mission_version`, `policy_version`, `expires_at` (14 days) and can be revoked.
`grantAllows` denies on any mismatch (stale mission, changed policy, other audience, extra field).

Before a summary can be shared, `findIdentifiers` refuses e-mail addresses, @handles, links and
phone numbers; the member has to rewrite the request.

**Deletion lineage.** `/forget_me` and cancel: grants revoked, live slots released, partner
exchanges withdrawn (partners delete summary and contact on receipt), local mission text
replaced by `[removed]`. Limits: a partner operator who already read a contact can't be made to
forget it; this is stated in the privacy notice. D1 Time Travel keeps up to 30 days of history
(plan-dependent) and encrypted backups follow their own retention.
