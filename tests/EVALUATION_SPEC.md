# Independent evaluation protocol

## Dataset
A locked 200-case fixture is required before release: 60 Russian, 60 English, 40 mixed-language, 40 adversarial privacy/prompt-injection cases. Store dataset version, policy version, source/evidence IDs and expected labels. Keep held-out cases inaccessible to implementation agents.

## Benchmarks
1. Retrieval: recall@10 >= 0.85, citation precision >= 0.95, baseline against FTS5 only; hidden evidence never appears.
2. Classification: macro-F1 >= 0.80 and recall(help_request) >= 0.90; initial suggestion threshold >= 0.80, never trigger irreversible actions automatically.
3. Expert finding: at least 30 approved skill-match examples, precision@3 >= 0.80 and zero opt-out leaks.
4. Workflow: test invalid transitions, replay, duplicates, expiry, revocation, recipient limits, outages and database restarts; zero unauthorized introductions.

## Independent gauntlet
Pin versions/commits for unread, Telebrief, TelAnalysis and TGTLDR at test setup. Reviewer sees anonymized competing outputs, not authors. Separate reviewer must identify the largest gap and reevaluate a new immutable candidate. External baselines do not supersede privacy/security gates.

## Release hard gates
- Zero unauthorized retrieval in 500 negative ACL cases.
- Zero unapproved provider egress in 500 negative cases.
- Zero unauthorized contact disclosure in full workflow transition tests.
- Restore and replay on clean environment reproduces authoritative normalized state.
- Human pilot, provider approvals, and review recorded independently.

These are test targets, not observed scores.
