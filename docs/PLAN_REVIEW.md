# Plan review and production readiness

Reviews `MASTER_PLAN.md` v1.0, records the v1.1 corrections (K1–K13 in `MASTER_PLAN.md`), and
tracks what stands between this code and a production launch.

## Verdict on the original plan

**Kept:** deny-by-default ACL applied before scoring; extractive cited answers; an outbox with an
honest `uncertain` state; consent-first experts and two-party introductions; one node on SQLite.

**Corrected:** the plan required ~130 gated items and two legally blocked external providers
before anything could ship. v1.1 ships vertical slices on a fully local stack. The privacy and
reliability gates stay hard, and the provider work moves after launch (K1, K2).

## Defects found in the v1.0 spec

| # | Issue | Fix |
|---|---|---|
| 1 | No roles/memberships, so `INTERNAL_RESTRICTED` and P02-03 could not be enforced | `members.role` + `source_access` (`storage/acl.py`) |
| 2 | No revision marker for out-of-order edits (P03-03) | `messages.edit_version`; older edits recorded, never applied |
| 3 | Outbox could not tell "never sent" from "crashed mid-send" | `dispatching` state; restart → `uncertain`, never auto-resent |
| 4 | "1 live invitation per request" not enforced | partial unique index |
| 5 | FTS keyed by an UNINDEXED column, so every delete scanned the table | FTS rowid = excerpt rowid |
| 6 | Raw events would retain names/usernames | minimized at normalization; blanked on delete |
| 7 | Weekly cap ambiguous (requester vs expert) | both apply (K3) |
| 8 | Digest "LLM fallback" with no LLM in scope | deterministic is the default (K7) |
| 9 | FTS5 has no Russian stemming/transliteration (QG02 risk) | prefix + RU↔Latin expansion; local embedder later (K2) |
| 10 | P00-01 "no history import" vs P03-06 importer | operator-only CLI import into enabled sources (K6) |
| 11 | Gold set (P00-04) blocks every numeric gate but sat in governance | must exist before canary (K11) |
| 12 | Calendar, OCR and ASR added scope with no launch value | dropped/deferred (K9, K10) |
| 13 | Web admin UI = new attack surface for a single owner | owner bot commands + CLI (K5) |

## What v1 implements

| Capability | Plan items | Code |
|---|---|---|
| Owner-enabled ingestion, idempotent, edits/deletes, minimized raw data | P03-01..09 | `ingest/service.py`, `ingest/normalize.py` |
| Desktop JSON history import | P03-06, K6 | `ingest/importer.py`, `telepathy import` |
| Documents: txt/md/html/vtt/srt/pdf/docx/pptx, page/slide/timestamp locators | P07-01,02,03,05,08,09 | `ingest/documents.py` |
| ACL-first FTS5 search, RRF, citation verify, translit, abstention | P05-07..09, P06-01..06, P06-09 | `retrieval/*`, `domain/translit.py` |
| 100-skill RU/EN taxonomy, opt-in profiles, eligibility, weighted ranking | P08-01,02,04..09 | `domain/experts.py`, `storage/experts.py` |
| Introductions: FSM, two-party consent, caps, 72h/14d expiry, 24h reminder, feedback | P09-01..06, P09-08..10 | `domain/intro.py`, `services/intros.py` |
| Daily admin digest, DST-safe, ACL-scoped, checkpoint after delivery | P10-01..05, P10-08, P10-09 | `services/digest.py`, `worker.py` |
| Forget-me, collection opt-out, retention | P08-09, P11-07, C13 | `services/data_rights.py` |
| Job ledger, outbox, crash recovery, uncertain reconciliation | P02-07/08, P09-06 | `storage/jobs.py`, `storage/outbox.py`, `/uncertain` |
| Backups with hash + integrity check + off-host hook; restore runbook | P11-05, P11-06 | `ops/backup.py`, `docs/RUNBOOK.md` |
| Metrics | P11-03 | `ops/status.py`, `/status` |
| Egress guard (deny all by default), rule classifier | P04-02,03,07,09 | `domain/egress.py`, `domain/classify.py` |
| systemd unit, Dockerfile, CI | P11-05, P01-05/08 | `deploy/`, `Dockerfile`, `.github/workflows/ci.yml` |

## Production launch checklist

Code-side items are done. The rest needs people:

- [ ] **Owner sign-off (P00-10):** privacy notice (`docs/PRIVACY.md`), retention (90 d), owner
      IDs, which groups and visibilities.
- [ ] **Deploy** on the host per `docs/RUNBOOK.md`. Pin the Docker base image digest.
- [ ] **Off-host encrypted backup** configured (`TELEPATHY_BACKUP_COMMAND`) and **one restore
      test** done.
- [ ] **Independent review** of ACL, the intro flow and data deletion (P11-10). The test suite
      gives a starting point: `tests/test_acl.py`, `test_intro.py`, `test_experts_intros.py`,
      `test_ops.py`.
- [ ] **Gold set** (P00-04): ≥ 200 labeled questions, written by someone other than the
      builder, run against FTS. Gate QG02 for the canary.
- [ ] **Pilot (P12-06):** one group, ~10 members try `/ask`, `/intro`, `/forget_me`; collect
      feedback.
- [ ] **Canary (P12-07)**, then enable the remaining groups.

## After launch (v1.x)

1. Local embeddings (multilingual-e5-small) as a separate index generation, if the gold set
   shows a recall gap.
2. Web admin UI (FastAPI/HTMX, localhost/VPN only).
3. Member-facing digests once the admin-only digest is accepted (P10-05).
4. Provider adapters only after signed approval (QG09).
