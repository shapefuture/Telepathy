# ADR-004: Trust beyond bilateral keys (evaluation)

**Status:** decided for now: bilateral allowlist only (2026-10-24). **Context:** plan §E.3, §F.2, P14-12.

| Option | What it gives | Cost now | Decision |
|---|---|---|---|
| Bilateral keys (`/partner add`) + manifest rotation proofs | each operator decides whom to trust; key changes need the old key's signature | done | **use** |
| OpenID Federation 1.0 trust chains and trust marks | a federation operator vouches for members; automatic discovery | needs an anchor organization, entity statements, metadata policy; no partner network yet | revisit when ≥ 3 independent operators want a shared anchor |
| A2A agent cards | interop with agent platforms | small | **done as transport only** (`/a2a`); A2A adds no trust |
| SpiceDB / relationship authz | fine-grained cross-org policy | separate service, not free-plan friendly | not needed while each node is one org (ADR-001) |

Rules that hold whichever option comes later: no transitive permissions (a partner of a partner
is nobody), per-message signatures, and member consent is never replaced by organizational trust.
