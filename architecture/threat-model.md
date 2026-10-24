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
