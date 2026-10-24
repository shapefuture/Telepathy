# Threat model (plan §J.1) → where it's handled → test

| Threat | Defense | Test (`worker/test/`) |
|---|---|---|
| Cross-community data bleed | separate node per org (ADR-001); envelopes carry 3 fields | federation: "signed inquiry with only allowed fields" |
| Capability membership inference | manifest lists categories only, no counts/people | federation: "node manifest reveals categories only" |
| Unauthorized onward disclosure | `forwarding: prohibited`, `max_hops: 1` enforced on receipt | federation: "rejects … forwardable inquiries" |
| Spoofed node | allowlisted keys, signature, audience check | federation: "refuses forged, misaddressed …" |
| Replay / double booking | nonce cache; atomic reserve; unique live commitment | federation (replay), assist: "two commitments for the last slot" |
| Prompt injection | no model in any decision path; texts are data | n/a (no LLM) |
| AI skill hallucination | offers are owner-published; self-claims ≠ availability | assist: offers only via `/offer` |
| Expert fatigue | hard capacity; per-partner daily inquiry cap | federation: "rate limit" |
| Covert marketing / poaching | contact only after member reveal grant, one partner | federation: approval contains contact only after choose |
| Deletion laundering | withdraw deletes partner copies; forget scrubs text | federation: withdraw; assist: forget |
| Disputed outcome | receipts with evidence level; unverified ≠ success | assist: receipts |
| SSRF via partner endpoint | https origin only, no IPs/ports/internal names | federation: "SSRF" |
| Stale consent | grants bound to mission + policy version | assist: "consent grants" |
| Key substitution via manifest | new key accepted only with a proof signed by the trusted key; 7-day grace for the old key | slices: "refuses a key change not signed by the trusted key" |
| A2A as a bypass | A2A only carries signed nexus messages through the same `receive` | slices: "A2A transport" |
| Ledger tampering / double posting | balanced entries only, one txn per business key, one reversal | slices: "ledger" |
| Gap signals identifying people | ≥ 5 distinct members, coarse buckets, no ids | slices: "gap signals" |
| Address hijack via stolen online key | primary changes need root threshold + relocation record | continuity: "a stolen online key can't move the audience" |
| Old consent revived by a restore | versioned ops; newest import wins; tombstones at send time | continuity: "restores can't re-enable an unfollow" |
| Email enumeration on login | same response shape for known and unknown addresses | continuity: "no address enumeration" |
| Portal CSRF / session theft | SameSite=Strict HttpOnly cookie, x-portal header, 2 factors for alerts | continuity: portal tests |
| Partner relays a fake relocation | verified against a pinned root, root-signed only | continuity: "forged or unpinned notices are refused" |
| Member list leakage via passes | pairwise pseudonym, one audience, 7 days | continuity: "a pass proves membership to one partner" |
| Correlated "independent" paths | failure domains + MX lookup + company parents + registry; index over joint failures | hydra: "two Gmail addresses are one head" |
| Fake club notice on a new head | every notice/receipt/heartbeat signed by the online key; clients verify against the pinned root | hydra: "signed public notices", vectors |
| Push endpoint as SSRF / spam cannon | only known push services and allowlisted ntfy servers; ≤10 heads per person; code rate limits | hydra: "arbitrary URLs are refused" |
| TOTP brute force / replay | 6 digits, ±1 step, replay guard, 5 failures lock 15 min | hydra: "lock the factor" |
| Device-key login replay | single-use 5-minute challenge; public JWK only stored | hydra: "one use" |
| Guardian social engineering | k approvals, 24 h delay, cancel link sent to the person's own heads first | hydra: "guardians" |
| Old receipt revives consent | sequence numbers; newest op wins; unfollow re-suppresses addresses | hydra: "an old receipt never overrides" |
| Escrow leak | ciphertext only leaves the Worker; per-recipient key wrap; hash check on decrypt | hydra: "ciphertext only" |
| One partner opens a sealed relocation early | Shamir k-of-n; each share released only after its holder sees silence + 3 down days | hydra: "only with k partners" |
| Gossip poisoning | re-verified at every hop; root threshold required for relocations; ≤3 hops | hydra: "verified end to end" |
