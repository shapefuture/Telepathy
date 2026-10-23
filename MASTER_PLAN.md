# Community Intelligence OS — Execution Master Plan v1.0

> Status: IMPLEMENTATION IN PROGRESS (see v1.1 corrections). All engineering tasks are unchecked. Do not infer build completion, successful provider authorization, or production rights from this document.

Version date: 2026-10-23. Scope: single community, Telegram-first, source-cited knowledge, expert finder, consent-based introductions.

## Canonical authority and usage

- **Authoritative status:** GitHub Issues once bootstrapped in the target repo. This Markdown is the portable initial backlog and coverage map, not a second live status tracker.
- **Target repo:** shapefuture/Telepathy (approved by the owner). Deployments still require P00-10 sign-off.
- **A checklist item is complete only with linked evidence:** CI job, commit SHA, independent reviewer, test artifact and requirement ID.
- **No credentials, Telegram content or personal data in GitHub issues, prompts or public artifacts.**
- Use isolated worktrees for independent workers. Schema, manifests, lockfile, CI and migrations have one integrator.
- **Acceptance rule:** no promotion with any hard gate failing. Numerical scores cannot compensate.

## Decisions locked by product owner

| Item | Locked decision |
|---|---|
| Runtime | Python 3.12; uv; Ruff; mypy; pytest; hash-pinned lock and container digest on release |
| Bot | aiogram 3 Bot API long polling for authorized groups, no user-account collection by default |
| Admin | FastAPI + Jinja2 + HTMX, bound to localhost or VPN; same node |
| Database | SQLite WAL + FTS5 + sqlite-vec; single writer transaction discipline |
| Jobs | Durable SQLite jobs, monotonic lease and outbox/effect journal; no Redis |
| Embeddings | NVIDIA NIM nvidia/nemotron-3.5-embed-1b, 1024 dims, passage/query input_type; **trial/synthetic only until legal provider authorization** |
| Classifier | vllm-sr/d3-turbo via /v1/systemone, fixed choice/noul questions; **non-sensitive approved inputs only** |
| Search | FTS top40 + authorized semantic top40 -> RRF k=60 -> evidence expansion/citation validation |
| Answer | Extractive cited answer first; no external generative model using real private content |
| Local semantic fallback | FTS5 only, then optionally intfloat/multilingual-e5-small with separate index and version |
| Documents | txt/md/html/vtt/srt, pypdf, python-docx, python-pptx; OCR optional offline, whisper.cpp optional offline |
| Profile | User opt-in for discovery and confirmed skill labels; no scraping LinkedIn |
| Expert rank | Eligibility first, then 0.40 domain + 0.25 helpfulness + 0.15 evidence + 0.10 context + 0.10 workload fairness |
| Introductions | mutual opt-in, single invitation at a time, 72h timeout, 24h opt-in reminder |
| Timezone | Store timestamps UTC; default community display timezone Asia/Jerusalem, configurable via audited admin setting |
| Deployment | One Linux host + encrypted off-host backup; no Next.js, graph DB, PostgreSQL, Redis or Kubernetes |
| AI agent runtime | AAA runtime autonomy AG0/AG1 only; no self-modifying runtime, persistent learning reviewed by humans |
| Tracker | GitHub Issues authoritative once wired; issue ID recorded for each task and gate |

## v1.1 corrections (2026-10-23) — fastest safe path to production

These override the sections below where they conflict. Rationale: `docs/PLAN_REVIEW.md`.
Checkboxes and issue status are unchanged; completion still requires recorded evidence.

| # | Area | Correction |
|---|---|---|
| K1 | Delivery model | Ship **vertical slices**, not 10-items-per-phase gates. v1 launch = P02, P03, P06 (FTS5), P07 (no OCR/ASR), P08, P09, P10 (admin-only), P11 ops minus web UI. Each slice still needs CI, tests and independent review. |
| K2 | External providers | NVIDIA NIM and d3-turbo adapters (P04-01..08, P05-01..06) are **deferred**. They are not on the v1 critical path, because legal approval (P00-08/QG09) is required before any real input. v1 production retrieval is FTS5 + prefix matching + RU↔Latin transliteration. Semantic search plugs into `retrieval.search(semantic=...)` via RRF once a **local** embedder (multilingual-e5-small) or an approved provider exists. |
| K3 | Introduction caps | **Both** limits apply: requester ≤ 2 open requests / 7 days, **and** expert ≤ 2 pending invitations / 7 days. At most 3 candidates per request, invited one at a time. |
| K4 | Expert discovery | `/expert` returns **counts only**. Identities are revealed only through a mutually confirmed introduction. Self-claimed skills are confirmed by the member's own statement; auto-detected skills stay private suggestions. |
| K5 | Admin UI | P11-01/02 (FastAPI/HTMX) deferred to v1.x. v1 admin = owner-only bot commands (`/enable`, `/disable`, `/retention`, `/forget`, `/status`, `/sources`, `/uncertain`, `/digest_now`) + CLI (`migrate`, `import`, `backup`, `verify`, `status`). No HTTP surface, so no CSRF or public-debug risk. |
| K6 | History import | P00-01 "no user history is imported" conflicts with P03-06. Resolution: import is allowed only for an already-enabled source, run by the operator on the host (no upload endpoint), through the same idempotent ingest path. Retention still applies. |
| K7 | Digest | Deterministic, extractive digest is the default (no LLM in v1). Recipients are admins/owners only (P10-05), and each digest is built from the recipient's own readable sources. |
| K8 | Schema authority | `src/telepathy/storage/migrations/*.sql` is authoritative. `architecture/schema.sql` is the historical reference. Added: roles, `source_access`, `edit_version`, outbox `dispatching`, one-live-invite index, collection opt-out, documents/locators, community settings. |
| K9 | Calendar (P09-07) | Dropped for v1. After mutual confirmation both parties get each other's live contact and arrange time directly. |
| K10 | OCR/ASR (P07-03/04) | Scanned PDFs are marked `needs_ocr` and reported in `/status`. No OCR or transcription runs in v1. Uploaded `.vtt/.srt` transcripts are supported. |
| K11 | Quality gates | QG01, QG05, QG06, QG07, QG09 stay **release-blocking**. QG02 (retrieval) is blocking for the canary and needs the P00-04 gold set, which an independent person must create **before** P12. QG03 (classifier) is non-blocking in v1, because the rule classifier only labels digest items and triggers no actions. QG04 needs ≥ 30 approved intents during the pilot. |
| K12 | Retention | Default 90 days per source, configurable by an owner (`/retention`). Nightly purge also blanks raw events. Backups keep 14 days. |
| K13 | Data rights | `/forget_me` deletes a member's messages, documents, skills, consents and live intros, and sets `collection_opt_out`, so future messages are not stored until `/resume_collection`. |

## Phase sequence and dependency gates

Each item below is deliberately specific. Checkbox markers start empty, do not mark them complete without its recorded acceptance evidence.

### P00 — Governance and benchmark freeze
**Depends on:** none. **Integration owner:** PM. **Risk:** R2–R4 as applicable.
- [ ] **P00-01 Scope and source inventory.** Record every authorized group, admin, visibility, consent route, expected throughput and retention; no user history is imported  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P00-02 Community constitution.** Ratify C01–C14 in architecture/constitution.yaml with community owner and independent privacy reviewer  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P00-03 Data categories.** Define PUBLIC_APPROVED, MEMBER_CONSENTED, INTERNAL_RESTRICTED, PRIVATE_UNKNOWN and rules for model egress  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P00-04 Evaluation fixture.** Create >=200 labeled synthetic/consented cases: 60 RU, 60 EN, 40 mixed, 40 adversarial; immutable IDs and sources  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P00-05 Reference implementations.** Pin comparable artifacts: unread for cited retrieval, Telebrief for digest, TelAnalysis for stats and TGTLDR for catch-up  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P00-06 Threat model.** Threat-model account takeover, data exfiltration, prompt injection, profiling, provider logs, poisoned citations, deletion, double introductions  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P00-07 Capacity baseline.** Define representative corpus: 100k messages, 2k episodes, 200 docs, 100 members; record measured laptop/VPS environment  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P00-08 External service gate.** Do not transmit identifiable community content to trial NVIDIA or free d3; obtain approved terms and DPA for real data or keep local  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P00-09 License audit.** Record library/model license, commercial permission and redistributed components; no copy/paste from noncommercial projects  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P00-10 Approval signoff.** Approve scope, retention, consent text, test data, and authority roles before implementation  _Evidence: issue/PR, tests, independent review, commit SHA._
**Phase gate P00:** all ten items have independent accepted evidence; all dependencies closed; security invariant checks green; integrated candidate build identified. No partial gate waiver.

### P01 — Repo, mission tracker and architecture gates
**Depends on:** P00. **Integration owner:** BE. **Risk:** R2–R4 as applicable.
- [ ] **P01-01 Inspect before bootstrap.** Read existing AGENTS.md, lockfile, CI, repo permissions, task tracker; preserve all existing content  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P01-02 Single tracker.** Use GitHub Issues as sole authoritative status; Markdown checkbox plan is specification only; never close items merely by editing file  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P01-03 Mission metadata.** Commit delivery/mission.json mapping requirements REQ-01..REQ-12 to issue IDs after issue creation  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P01-04 Create phase epics.** Create exactly P00..P12 epic issues, and 10 implementation issues per phase with predecessor and criterion; keep IDs in taskmap.json  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P01-05 Initialize code.** Adopt Python 3.12, uv project, Ruff, mypy, pytest and pinned uv.lock; prohibit floating production dependencies  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P01-06 AAA constitution.** Install C01..C14 invariants and roles; classify E0..E5 external effects and R0..R4 risks  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P01-07 Ports/contracts.** Create versioned connectors for Telegram, embedder, classifier, synthesizer, storage, identity and notifications  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P01-08 Independent validation.** CI requires types, unit, contract, ACL/replay, migration and architecture import tests; verifier identity differs from builder  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P01-09 Workcell fences.** Each parallel agent gets isolated worktree and explicit read/write glob; shared schema/lockfiles modified by integrator only  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P01-10 Reproducible releases.** Each candidate records commit SHA, lock hash, config schema, policy hash, migration ID and rollback artifact  _Evidence: issue/PR, tests, independent review, commit SHA._
**Phase gate P01:** all ten items have independent accepted evidence; all dependencies closed; security invariant checks green; integrated candidate build identified. No partial gate waiver.

### P02 — Core database, ACL and evidence model
**Depends on:** P01. **Integration owner:** BE. **Risk:** R3 for data/authority actions; otherwise R1–R2.
- [ ] **P02-01 SQLite schema.** Build tables: communities, memberships, sources, raw_events, messages, conversations, documents, excerpts, evidence  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P02-02 Domain identity.** Add persons, telegram_identities, consent, skill_claims, needs, offers, relationships, introductions  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P02-03 Access-control schema.** Every source and derivative has community_id, visibility, permitted_roles, restriction version, expiry/deletion references  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P02-04 Time model.** Store event_at, observed_at, valid_from, valid_to and supersedes_id for temporal knowledge  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P02-05 FTS5 indexes.** Create secure FTS5 projections keyed by evidence_id; normalize Unicode NFC, casefold and store Cyrillic tokens  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P02-06 Vector staging.** Add embeddings table with model_id, dimension, input_type, content_hash, version; reject incompatible dimensions  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P02-07 Job ledger.** Add durable jobs with state, lease_owner, lease_until, attempts, next_run; unique job dedup key  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P02-08 Effect outbox.** Add effect_intents and delivery receipts with UUID effect_id; never claim exactly-once external Telegram delivery  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P02-09 Migrations and rollback.** Create additive forward migration and backup/restore path; run migrations on a disposable copy  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P02-10 ACL red-team tests.** 100% of negative ACL tests deny cross-community, deleted, withdrawn, unapproved profile data  _Evidence: issue/PR, tests, independent review, commit SHA._
**Phase gate P02:** all ten items have independent accepted evidence; all dependencies closed; security invariant checks green; integrated candidate build identified. No partial gate waiver.

### P03 — Telegram ingestion and historical import
**Depends on:** P02. **Integration owner:** BE. **Risk:** R3 for data/authority actions; otherwise R1–R2.
- [ ] **P03-01 Bot setup.** aiogram long polling, one supervisor process, one bot token; document privacy mode and group notice  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P03-02 Authorized source registry.** Only collect group IDs explicitly enabled by authorized admin; no unlisted chats  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P03-03 Event idempotency.** Unique key (source_platform, chat_id, message_id, edit_revision) with duplicate-replay tests  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P03-04 Message normalization.** Text, text_entities, captions, sender pseudonym IDs, topic_id, reply_to, timestamp, edit metadata, source deep link  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P03-05 Conversation reconstruction.** Rebuild replies and forum topics deterministically; link orphan replies without fabricating parent content  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P03-06 JSON importer.** Support Desktop result.json and its mixed text arrays; accept upload only from privileged admin with provenance  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P03-07 Sync high-water mark.** Store last accepted update checkpoint only after local transaction commits  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P03-08 Deletion/edit handling.** Update source and mark derivatives stale; bot deletion blind spots documented and reconciliation job supported  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P03-09 Media metadata.** Store file IDs/media types only until media retention and consent are approved  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P03-10 Replay chaos tests.** Replay 100k mixed events with duplicates and out-of-order edits; compare resulting state hashes  _Evidence: issue/PR, tests, independent review, commit SHA._
**Phase gate P03:** all ten items have independent accepted evidence; all dependencies closed; security invariant checks green; integrated candidate build identified. No partial gate waiver.

### P04 — d3-turbo classifier and privacy membrane
**Depends on:** P03. **Integration owner:** ML. **Risk:** R3 for data/authority actions; otherwise R1–R2.
- [ ] **P04-01 Provider metadata probe.** Implement GET models/info/keys status with no content; fail closed when model ID/version/limits differ  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P04-02 Outbound policy guard.** Classifier adapter accepts only PUBLIC_APPROVED or separately authorized/redacted content; forbid arbitrary text from private groups  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P04-03 Pseudonymize eligible input.** Strip handles, phone, emails, credentials, URLs with tokens, personal names where reliably detectable; block unsanitizable input  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P04-04 Structured question schema.** Use fixed `choice` primary_intent and `noul` help_request, offer, answer_candidate; no open-ended generation  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P04-05 Request cap.** One message per call; 3 question types max; 1200 Unicode character state cap; cache by salted content digest+schema version  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P04-06 Typed response parser.** Verify model==vllm-sr/d3-turbo, recognized choice labels, finite probabilities and all required answers  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P04-07 Decision thresholds.** Publish help candidate at p>=0.80 as private suggestion only; 0.50..0.80 review; lower discard; never infer competence  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P04-08 Quota behavior.** On 429 respect Retry-After + jitter, max 3 retries; on 401/403/422/503/504 mark deferred/manual without interrupting ingestion  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P04-09 Fallback classifier.** Deterministic text patterns for explicit question/help offer and private /ask commands; uncertain messages are not silently promoted  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P04-10 Gold classification benchmark.** Per-language macro-F1 >=0.80, help-request recall >=0.90 on labeled set; else human review and no auto alerts  _Evidence: issue/PR, tests, independent review, commit SHA._
**Phase gate P04:** all ten items have independent accepted evidence; all dependencies closed; security invariant checks green; integrated candidate build identified. No partial gate waiver.

### P05 — NVIDIA embeddings and hybrid retrieval
**Depends on:** P03,P04. **Integration owner:** ML. **Risk:** R3 for data/authority actions; otherwise R1–R2.
- [ ] **P05-01 NVIDIA adapter.** POST integrate.api.nvidia.com/v1/embeddings with model=nvidia/nemotron-3.5-embed-1b  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P05-02 Embedding contract.** Passage for index, query for retrieval, dimensions=1024, encoding_format=float, truncate=NONE; reject dimension mismatch  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P05-03 Content segmentation.** Group conversations as coherent episodes; text chunks target 350 tokens, max 600, 70-token overlap for long documents  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P05-04 Egress approval.** Embed only PUBLIC_APPROVED or specifically authorized, redacted content; synthetic demo unrestricted within trial terms  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P05-05 Caching.** Cache by SHA256 of normalized allowed text+model+dim+purpose+policy version; never share cross-tenant embeddings  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P05-06 SQLite vector store.** Store vectors and provenance with sqlite-vec; query only authorized source IDs before ranking/exposing results  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P05-07 Exact search fallback.** When provider is down or vector unavailable, return FTS5 search with metadata rather than fake semantic results  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P05-08 Fusion.** Retrieve FTS top 40 and vector top 40, fuse RRF(k=60), then source-expand to 30 evidence passages  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P05-09 Citation verifier.** Before response require passage IDs map to accessible unchanged excerpts; stale or deleted evidence excluded  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P05-10 Benchmark and model versioning.** Recall@10 >=0.85 and citation precision >=0.95 vs 200-case set; 1024-vs-2048 ablation logged; any model change reindexes  _Evidence: issue/PR, tests, independent review, commit SHA._
**Phase gate P05:** all ten items have independent accepted evidence; all dependencies closed; security invariant checks green; integrated candidate build identified. No partial gate waiver.

### P06 — Member Q&A and answers
**Depends on:** P05. **Integration owner:** BE. **Risk:** R3 for data/authority actions; otherwise R1–R2.
- [ ] **P06-01 Member identity.** Use authorized Telegram IDs and membership checks for /ask; do not trust free-form chat IDs from request  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P06-02 Retrieval gate.** All candidate source IDs are ACL-filtered before snippet extraction; test hidden-source contamination  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P06-03 Extractive answer template.** Return concise quote/snippet, source, date and uncertainty; no invented synthesis when evidence conflicts  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P06-04 Insufficient evidence.** When top evidence under threshold or contradicts, clearly return no reliable answer and optional expert search  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P06-05 Exact source references.** Telegram t.me deep links and meeting mm:ss references; handle inaccessible links gracefully  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P06-06 Bilingual search.** Handle Russian, English, code-switched spelling and transliteration fixtures  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P06-07 Question feedback.** Allow helpful/not-helpful/incorrect citation buttons; store no public personal judgements  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P06-08 Latency target.** Pilot p95 <=8s without external generation on reference host; record hardware rather than inventing benchmarks  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P06-09 Adversarial prompt injection.** Treat quote/document content as evidence only; instructions embedded in messages never authorize tool actions  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P06-10 Gauntlet comparison.** Blind A/B vs configured unread outputs on gold questions; ours must preserve zero-ACL-leak gate and improve >=1 measured metric  _Evidence: issue/PR, tests, independent review, commit SHA._
**Phase gate P06:** all ten items have independent accepted evidence; all dependencies closed; security invariant checks green; integrated candidate build identified. No partial gate waiver.

### P07 — Meetings, documents and knowledge lifecycle
**Depends on:** P02,P05. **Integration owner:** BE. **Risk:** R3 for data/authority actions; otherwise R1–R2.
- [ ] **P07-01 Transcript ingestion.** Accept txt, vtt, srt with timestamps; speaker uncertain status recorded  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P07-02 Document ingestion.** Support PDF via pypdf, DOCX via python-docx, PPTX via python-pptx, MD/TXT natively  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P07-03 OCR gate.** Scanned PDF marked needs_ocr; no hidden third-party submission; optional manual OCR pipeline  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P07-04 Speech gate.** Use whisper.cpp as offline optional batch transcription after recording-consent approval  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P07-05 Meeting topic segments.** Chunk by times and topic transitions; maintain links back to original transcript and permission scope  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P07-06 Knowledge claim store.** Persist claims with evidence refs, asserted_by, extracted_at, valid_from and review_state  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P07-07 Supersession handling.** Correction creates new claim, invalidates dependent answers and marks earlier claim superseded  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P07-08 Evidence removal.** On deletion revoke excerpt, remove relevant embeddings/FTS, re-evaluate impacted claims and cached answer hashes  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P07-09 Source integrity.** SHA256 source binaries and normalized excerpts; preserve ingest and parsing version  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P07-10 Gold meeting evaluation.** Test 20 consented/synthetic meetings; >=95% cited snippets match timestamped transcript; no fabricated quotes  _Evidence: issue/PR, tests, independent review, commit SHA._
**Phase gate P07:** all ten items have independent accepted evidence; all dependencies closed; security invariant checks green; integrated candidate build identified. No partial gate waiver.

### P08 — Expert directory and grounded matching
**Depends on:** P02,P06. **Integration owner:** BE. **Risk:** R3 for data/authority actions; otherwise R1–R2.
- [ ] **P08-01 Skill taxonomy.** Seed 100 curated RU/EN skills plus synonyms; version schema and avoid opaque personality ranking  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P08-02 Consent by default.** Member profile undiscoverable until they explicitly opt in via bot  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P08-03 Import existing profiles.** Allow member-uploaded CV/CSV/LinkedIn export and admin-owned existing directory; no unauthorized scraping  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P08-04 Reviewable suggestions.** Auto-detected skills remain private suggestion pending member confirmation  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P08-05 Evidence categories.** Tag self_claim, validated_role, teaching_contribution, confirmed_help_outcome, weak_conversation_signal  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P08-06 Hard eligibility.** Filter membership, consent, skill match, availability, cooldown, visibility, conflicts before scoring  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P08-07 Ranking formula.** Among eligible candidates score 0.4 domain+0.25 helpfulness+0.15 evidence+0.1 context+0.1 load fairness; log components  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P08-08 No profiling abuse.** No personality, health, inferred private characteristics or unsolicited competence ratings  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P08-09 Profile correction.** Member can view, correct, hide, revoke and delete their discoverable profile and links  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P08-10 Expert gold set.** 30 approved test intents, precision@3 >=0.80 after member review; 100% opt-out respected  _Evidence: issue/PR, tests, independent review, commit SHA._
**Phase gate P08:** all ten items have independent accepted evidence; all dependencies closed; security invariant checks green; integrated candidate build identified. No partial gate waiver.

### P09 — Consent-based introduction workflows
**Depends on:** P08. **Integration owner:** FE. **Risk:** R3 for data/authority actions; otherwise R1–R2.
- [ ] **P09-01 Intent capture.** /intro request creates need with short text, audience and lifespan; no mass unsolicited contact  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P09-02 Candidate capacity.** Default max 2 pending requests/member/week, and max 1 invitation at once per request  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P09-03 State machine.** requested>candidate_selected>invited>accepted>mutually_confirmed>scheduled>completed; terminal declined/expired/cancelled  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P09-04 Two-party consent.** Reveal no contact details before each party authorizes the introduction  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P09-05 Expiration.** Invitation expires after 72h; request expires after 14d; persisted UTC times with configurable display timezone  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P09-06 External effects.** Use outbox intent with effect_id, mark sent only with Telegram response; uncertain network result enters reconcile/manual mode  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P09-07 Calendar workaround.** Start with manual proposed slots or booking link; no Google/Microsoft OAuth in MVP  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P09-08 Reminders.** One reminder after 24h if opted in, never send after decline/cancel or contact-limit exhaustion  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P09-09 Outcome feedback.** Optional helpful/no response/decline feedback; do not expose private ratings  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P09-10 State-machine adversarial tests.** Exhaustive transition table, duplicate-click/replay, revoke-midflight, forbidden disclosure tests  _Evidence: issue/PR, tests, independent review, commit SHA._
**Phase gate P09:** all ten items have independent accepted evidence; all dependencies closed; security invariant checks green; integrated candidate build identified. No partial gate waiver.

### P10 — Daily digests and proactive intelligence
**Depends on:** P06,P07. **Integration owner:** BE. **Risk:** R3 for data/authority actions; otherwise R1–R2.
- [ ] **P10-01 Scheduled digest.** Default 09:00 Asia/Jerusalem, saved UTC next_fire_at using zoneinfo; DST simulation across transitions  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P10-02 Noisy-chat compression.** Use conversation episodes and distinct needs, not top-message counts or full message dump  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P10-03 Digest schema.** Topics, question/answer pairs, unresolved needs, correction notices, event references and cited source IDs  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P10-04 Consent and audience.** Member opt-in and per-group scope; no automatic forwarding of restricted-group information  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P10-05 Review before broadcast.** First pilot digests admin-only; public digest requires moderation approval until acceptance gate  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P10-06 Event intelligence.** D3-classified signals become draft moderator items, not automatic cold DMs  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P10-07 Change detection.** Compute added/updated/resolved needs and superseded claims since last successful digest  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P10-08 Reliability.** Job ledger ensures successful-day checkpoint only after delivery accepted or explicit reconciliation  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P10-09 Fallback digest.** If LLM unavailable, send deterministic source-link digest; no invented narrative  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P10-10 Digest evaluation.** >=95% valid citations, 0 restricted leaks, >=90% scheduled sends within 10 min over test schedule  _Evidence: issue/PR, tests, independent review, commit SHA._
**Phase gate P10:** all ten items have independent accepted evidence; all dependencies closed; security invariant checks green; integrated candidate build identified. No partial gate waiver.

### P11 — Admin, operations and delivery quality
**Depends on:** P03,P06,P09,P10. **Integration owner:** FE. **Risk:** R3 for data/authority actions; otherwise R1–R2.
- [ ] **P11-01 Admin UI.** Jinja2+HTMX local/private UI: sources, pending profiles, evidence, jobs, audits, deletion requests  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P11-02 Access enforcement.** Telegram signed identity for member UI; admin session with CSRF defense and no public debug API  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P11-03 Operational metrics.** Ingest lag, classified rate, queued jobs, 429/5xx provider failures, citation errors, storage use, model cost  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P11-04 Secrets and data.** Environment/OS key store, never logs or tracker; locally encrypt backups and sessions  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P11-05 Service startup.** systemd unit with Restart=on-failure and explicit SQLite WAL shutdown/backup process  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P11-06 Backups.** Nightly SQLite online backup plus file hashes, off-host encrypted copy; monthly restore test  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P11-07 Data rights.** Member consent withdrawal triggers complete per-person derived data invalidation within policy deadline  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P11-08 Performance.** Record single-node RSS, disk and p95 Q&A under representative corpus; storage cost forecast  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P11-09 Documentation.** Write operator runbook, setup, privacy notice, deployment rollback and on-call page  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P11-10 Independent security review.** Separate reviewer tests ACL, egress guard, token leakage, intro state and recovery before production  _Evidence: issue/PR, tests, independent review, commit SHA._
**Phase gate P11:** all ten items have independent accepted evidence; all dependencies closed; security invariant checks green; integrated candidate build identified. No partial gate waiver.

### P12 — Shadow validation, canary and release
**Depends on:** P00..P11. **Integration owner:** QA. **Risk:** R3 for data/authority actions; otherwise R1–R2.
- [ ] **P12-01 Baseline freeze.** Capture immutable generation hash, database schema and fixture/evaluator hashes  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P12-02 Shadow pilot.** Run with synthetic or lawfully authorized pilot data, no automated publication or unsolicited matching  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P12-03 Provider contract gate.** NVIDIA production rights / privacy agreement and d3 processing permission documented, or local substitute engaged  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P12-04 Failure campaign.** Inject provider 429/503, restart, duplicate updates, disk-full, interrupted send and deletion during reindex  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P12-05 Golden QA.** Re-run locked 200-case gold suite; independent verifier owns labels and immutable harness  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P12-06 User validation.** At least 10 authorized pilot members try /ask, /expert and /intro; record task outcomes  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P12-07 Canary.** Enable 1 group and opt-in subset, shadow comparisons daily, rollback trigger on hard invariant  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P12-08 SLO dashboard.** Track acceptance, citation precision, p95 ingest and Q&A, delivery, member correction requests  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P12-09 Release decision.** Independent reviewer and community owner sign evidence bundle and approve release generation  _Evidence: issue/PR, tests, independent review, commit SHA._
- [ ] **P12-10 Handoff.** Publish outstanding risks, owner, exact deployed commit, recovery procedure, and next revision backlog  _Evidence: issue/PR, tests, independent review, commit SHA._
**Phase gate P12:** all ten items have independent accepted evidence; all dependencies closed; security invariant checks green; integrated candidate build identified. No partial gate waiver.

## Hard quality gates (release-blocking)

- [ ] **QG01 Privacy:** zero unauthorized source disclosures in 500 adversarial ACL tests; 0 successful confidential provider egress.
- [ ] **QG02 Retrieval:** recall@10 ≥ 0.85 on locked 200-case RU/EN/mixed/adversarial corpus; factual citation precision ≥0.95.
- [ ] **QG03 Classification:** macro-F1 ≥0.80 across intent classes and help-request recall ≥0.90 in the approved gold set; unclear cases route to review.
- [ ] **QG04 Expert matching:** precision@3 ≥0.80 on 30 approved intents; 100% opt-out and rate-limit enforcement.
- [ ] **QG05 Introductions:** 100% of simulated terminal state transitions enforce two-sided consent and avoid unauthorized contact disclosure.
- [ ] **QG06 Recovery:** 100k-event deterministic replay, fault-injected duplicate, outage and restart tests yield consistent state.
- [ ] **QG07 Delivery:** scheduled digest accepted within 10 minutes ≥90% in injected test schedule; no duplicate sends from normal retry flow; uncertain sends explicitly reconciled.
- [ ] **QG08 Throughput:** on recorded reference hardware ingestion lag p95 ≤30 sec under defined benchmark workload; search/extractive answer p95 ≤8 sec.
- [ ] **QG09 Provider/legal:** any production external egress requires signed authorization, agreed terms and confirmed lawful content scope; otherwise disabled.
- [ ] **QG10 Independence:** builder and evaluator identities differ; verifier runs on clean same commit and hidden data.

## TRIZ contradictions and far-transfer resolutions

| Contradiction | TRIZ principle | Far-transfer analogy | Hardcoded resolution |
|---|---|---|---|
| Free hosted AI vs confidential chats | Separation / intermediary | Airport security sterile zone | Policy firewall: only approved nonsensitive payloads egress; local fallback |
| Real-time capture vs zero infrastructure | Prior action / dynamicity | Write-ahead log | Persist events immediately, defer expensive computation |
| Knowledge reuse vs obsolete advice | Segmentation / dynamization | Version control and temporal ledgers | Claims carry validity interval + supersedes + citation |
| Expert discovery vs privacy | Separation in condition | Zero-trust capability tokens | Expert search requires opt-in; private evidence never displayed |
| Accurate matching vs unfair expert overload | Feedback / local quality | Load-balanced job scheduling | Eligibility then weighted score + weekly cap + feedback |
| Fast retrieval vs strong ACL | Prior counteraction | Database row-level policies | Authorized candidates restricted before vector scoring |
| Rich profiles vs long forms | Self-service / prior action | Progressive onboarding | Import member-provided data, show 2-minute confirm UI |
| Many agent developers vs one reliable codebase | Segmentation / intermediary | Bazel / immutable build artifacts | Workcells isolated; integrator merges only versioned contracts |
| Retry reliability vs duplicate messages | Feedback / intermediary | Transactional outbox | Effect ledger + receipts + uncertain reconciler, never blind resend |
| Free model quality vs model churn | Universality / nested doll | Hardware abstraction layer | Strict adapter slot, contract tests, versioned embeddings and full reindex |
| Lightweight storage vs graph reasoning | Copying / intermediary | Materialized projections | SQLite relational links + CTE until graph benchmark proves gain |
| Automatic answers vs hallucination | Preliminary action / feedback | Scientific evidence ledger | Evidence-first extractive output; explicit abstention |

## Gauntlet Loop quality mechanism

- Build named real comparator artifacts using tagged versions: **unread** (cited Q&A), **Telebrief** (daily digests), **TelAnalysis** (activity analytics), **TGTLDR** (catch-up). Licensing reviewed before reusing code.
- Create fixed 200-case evidence corpus and separate hidden 40-case adversarial set; never let candidate builder modify hidden test cases or scoring.
- Per vertical slice, builder returns immutable candidate commit, tests and evidence; separate critic opens artifacts and comparator, blinds labels, reports single largest measurable gap.
- Repair only that gap; rerun hard gates and A/B; do not declare a win based on aesthetics or model assertion. Independent reviewer signs accepted candidate.
- Stop a phase only when release gates pass and either blind comparator wins or the actual product owner accepts a documented tradeoff with evidence; never weaken privacy/reliability hard gates.
- If two successive passes do not materially improve, diagnose whether benchmark/comparator/scope is wrong and move to useful prerequisite work; record blocker.

## AAA v7.1 constitution and development controls

- Runtime chosen **AG1 bounded model-assisted analysis** only for authorized text. AG2 memory promotion is NOT autonomous: knowledge/skills remain proposed and reviewable; AG3/AG4 self-change disabled.
- Classes: E0 pure, E1 reads, E2 monotone append, E3 reversible DB change, E4 idempotency-supported external, E5 irreversible Telegram sends and personal introductions.
- Changes: M0 refactor, M1 behavior, M2 schema, M3 external effects/permissions, M4 governance; M3/M4 require independent sign-off.
- Release states `BUILT -> VERIFIED -> SHADOW -> CANARY -> ACTIVE`; rollback to known generation via version pointer and forward-compatible data migration.
- Keep control journal append-only for policy/config/version/change/effect approvals; immutable evidence for critical external effects.
- No development agent may update evaluator/hidden fixtures/policy/production secrets or active deployment. Shared contract edits owned by integration lead.

## Release and recovery playbooks

- **Provider 429/503:** no data loss; store deferred state; honor Retry-After; FTS/source-only fallback; operator alert after retry ceiling.
- **Unknown Telegram send outcome:** effect stays `uncertain`, read ledger and reconcile with source/admin rather than duplicate blindly.
- **Message deletion or membership revoked:** mark evidence stale immediately, exclude from results and enqueue dependent projection invalidation/rebuild.
- **Vector dimension or provider change:** add new index generation and populate separately, validate recall/ACL, atomically swap index version; retain old until verified.
- **DB migration:** online backup first; additive migrations; run recovery on a copy; never downgrade incompatible schema by code rollback.
- **Lost community approval:** disable ingest and egress for source; quarantine derivative projections until policy resolution.

## Sources and governing references

- [Gauntlet Loop](https://github.com/robonuggets/gauntlet-loop/blob/main/.claude/skills/gauntlet-loop/SKILL.md)
- [Full Plan Delivery](https://github.com/shapefuture/ArchetypeAI/blob/main/.agents/skills/full-plan-delivery/SKILL.md)
- [AAA v7.1 Specification](https://github.com/shapefuture/AAA-Architecture/blob/main/AAA-V7-SPEC.md)
- [NVIDIA Nemotron 3.5 inference reference](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-embed-1b-infer)
- [NVIDIA API trial terms](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf)
- [Decision 3.0 API](https://decision.vllm-sr.ai/docs)
- [Decision 3.0 privacy](https://decision.vllm-sr.ai/privacy)

## Artifact truth statement

No work has been implemented in the product repository. All checklist items remain unchecked, with zero accepted evidence, until team actions and independent verification complete. This is an implementation-ready plan, not a representation of live progress.