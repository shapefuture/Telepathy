# TELEPATHY → THE OPPORTUNITY INTERNET
## Evidence-grounded transformation master plan: product, architecture, protocol, operating model and gates

**Status:** Proposed plan, not an implemented or proven service. **Basis inspected:** `shapefuture/Telepathy` main and open [PR #145](https://github.com/shapefuture/Telepathy/pull/145), PR head `8eb94575f93d23870e2f1c1bd37db387f35f6ca2`; previous 315-feature inventory; Nexus blueprint; 735-query competitor mapping; 120-query voice-of-customer corpus; 94-item NMT/AJTBD redesign; Opportunity Internet breakthrough blueprint; official NMT/JTBD materials. **Scope:** staged evolution, no assumption that the existing candidate has passed production acceptance. **All numerical targets below are proposed decision thresholds, not observed metrics.** No implementation or roll-out duration is promised.

## Executive decision

Keep **Telepathy as the trusted local community kernel**. Add an **Assistance OS** for completing qualified member needs, and then an **interoperable Community Capability Clearinghouse** that coordinates separate organizations without consolidating their underlying social graphs or knowledge archives.

**The promise to operators:** "Your community shouldn't run out of ways to help. Keep your members, brand and data; extend what your membership can deliver." **The member's interaction:** ask from the home community, understand what is being offered, consent before any onward disclosure, receive an answer or verified assistance, and know what happened. **The provider community's bargain:** genuine opt-in demand, configurable capacity and commercial terms, no bulk data transfer or unwanted solicitation. **The platform partner's bargain:** white-label federation API, not a forced Community OS migration.

The true sellable primitive is a **bounded assistance episode** (qualified request → permitted investigation → real willingness and approval → promised service actually occurs → receipt). The global success metric is *incremental, useful cross-community service completion per eligible mission*, with privacy and human-attention limits as non-negotiable constraints. Count matches and intros only as intermediate diagnostics.

## A. Baseline audit of what is genuinely in the Telepathy draft

### A.1 Status and authoritative references

- [Repository main](https://github.com/shapefuture/Telepathy): a README/planning base; no production deployment represented on main.
- [PR #145](https://github.com/shapefuture/Telepathy/pull/145): **open and unmerged**. Its body describes an implementation candidate with a Cloudflare Worker (`worker/`) and a self-hosted Python variant (`src/telepathy/`). Its reported 103 Worker and 400 Python tests have **not** been independently run during this review.
- [Worker README](https://github.com/shapefuture/Telepathy/blob/claude/vibrant-curie-7qfs74/worker/README.md), [deploy guide](https://github.com/shapefuture/Telepathy/blob/claude/vibrant-curie-7qfs74/docs/DEPLOY_CLOUDFLARE.md), [production checklist](https://github.com/shapefuture/Telepathy/blob/claude/vibrant-curie-7qfs74/docs/PLAN_REVIEW.md), [draft privacy notice](https://github.com/shapefuture/Telepathy/blob/claude/vibrant-curie-7qfs74/docs/PRIVACY.md), [engineering constitution](https://github.com/shapefuture/Telepathy/blob/claude/vibrant-curie-7qfs74/architecture/constitution.yaml).
- Existing code has /ask with source citations, Telegram FTS5-based search with RU/Latin variants and RRF, source ACLs, opted-in skills and count-first expert discovery, consented introductions, two-sided confirmation, capped invitations, idempotent ingest, outbound send ledger with uncertain/reconciliation state, data deletion controls, digests, feedback, language switching, and a signed-initData Mini App. These are branch implementation claims, not live validated features.

### A.2 Code-by-code disposition

| Existing file / subsystem | Action | Integration rule |
|---|---|---|
| `worker/src/ingest.ts`, `search.ts`, `text.ts` | RETAIN as LocalKnowledgeAdapter | Never use home-community raw search as federated global search; enforce source visibility before scoring and citation; later add approved summarized knowledge artifacts. |
| `worker/src/acl.ts` | REFACTOR to domain policy + scope | Existing single-context roles and source grants are insufficient for separate independent organizations. Cross-community defaults must be DENY. |
| `worker/src/experts.ts`, `skills.json` | ADAPT to local Claim/Capability evidence | Keep opt-in skills but differentiate self-claim, completed work, third-party attestation, actual current willingness, and booked capacity. No opaque competence scoring as authority. |
| `worker/src/intros.ts` | EXTRACT pure consent state machine | Preserve two-party approvals; add intermediary and organizational approvals at boundaries, distinct requester/candidate role, disclosure levels, cancellation propagation. |
| `worker/src/outbox.ts`, `telegram.ts` | PRESERVE and EXTEND | Durable effect intents, idempotency keys, external-send uncertainty and human reconciliation must survive new workflows. Never advertise exact-once Telegram send. |
| `worker/src/rights.ts` | HARDEN | Extend erasure/withdrawal graph through derived artifacts, offers, cache, receipts, queues, provider gateways and backup retention; preserve legally required minimal audit separately. |
| `worker/src/app.ts`, `index.ts`, `bot.ts` | ADD home-community mission UX | Bot remains default entry; Mini App only for review/approvals, operator desk, richer status. Verify signed Telegram initData server-side. |
| `worker/src/hints.ts`, `feedback.ts`, `digest.ts`, `features.ts` | KEEP as local supplements | Reuse approved answers, events and feedback; do not make engagement/viral mechanics the main service. |
| `worker/migrations/*.sql` | ADD FORWARD MIGRATIONS | Do not overload `needs`/`intros` as if they were complete federal objects. Use new mission, agreement, capability and exchange tables; migrate legacy data explicitly. |
| `src/telepathy/` | ARCHIVE as optional Python adapter or maintain single agreed fork | Avoid two unsynchronized authoritative product cores. A Python parsing worker can stay a separately authenticated processor. |
| `architecture/constitution.yaml` | EXPAND C01–C14 with federation invariants | Existing no-egress, no-unauthorized-source, consent and effects constraints remain hard gates. |

### A.3 Critical technical issues to address

1. **One-community schema assumption.** Worker `members.tg_id` and `sources.chat_id` are globally unique; there is no first-class `organization`, `tenant`, `federation_node`, community-specific membership role or per-partner trust agreement. The existing `skills`, `needs`, `intros` are bound to local member identifiers rather than signed federation objects.
2. **Single D1 database and app context.** This is adequate for a local pilot but cannot be equated with independently governed data custody. Plan a tenant placement boundary and an eventual per-tenant/independent gateway option.
3. **Current `needs` have `text`, `skills_json`, basic state, expiry.** Upgrade to job outcome, qualification, data-classification, mission permissions, provider eligibility, observable service completion and evidence record.
4. **Consent for intro is only a subset.** Candidate acceptance + requester confirmation does not authorize initial disclosure to external communities, allow all intermediary actions, or establish organization-to-organization data-processing agreements.
5. **Raw Telegram collection is sensitive.** The existing deploy guide requires full group message visibility (admin/privacy mode disabled), and the draft notice defaults to full history unless configured. This must be an explicit operator/member-governance choice; a command-only mode should allow Nexus without broad chat ingestion.
6. **Out-of-band document processing.** GitHub Actions document offload is opt-in but transfers community documents through third-party runners; evaluate processor disclosures, agreements, retention, locality and acceptable offload alternatives.
7. **Search derived-data erasure.** Forgetting messages must invalidate source-linked snippets, approved summaries, vector indexes, cross-community projections and caches. Existing local deletion code alone does not fulfill those future obligations.
8. **Operational readiness remains open.** Owner signoff, independent security review, representative retrieval gold set, backup restoration, real Telegram group and role-permission acceptance are prerequisites to production.

## B. Target operating model: three nested products

**L0 / Local Community Intelligence Kernel:** compliant source-cited search, local expertise, consent-based introductions, Telegram Mini App, opt-in memory, data rights. This creates immediate local value before federation.

**L1 / Community Assistance OS:** a branded Unsolved Request Desk with member Job Cards, operator triage, qualification, knowledge-first handling, volunteer/contracted expert capacity, service commitments, handoff tracking, follow-up, and completion receipts. This is the first separately sellable offer.

**L2 / Community Capability Clearinghouse:** an organization registry, sovereign partner gateways, publishable capability manifests, bounded Opportunity Envelopes, permission-scoped offers, commitments, partner routing, reciprocal/commercial accounting, delegated benefits, dispute procedures and auditable effects. The routing layer must work when another community uses unrelated software.

**L3 / Opportunity Internet:** multiple networks and platform integrations, independent hosting, approved federation-to-federation routing, dynamic supply creation, formal community trust and interoperability rules, reliability reputation at the organization/service level, AI-assisted teamwork and collective problem-solving. L3 is not a prerequisite to selling L1.

### B.1 Five simultaneously satisfied JTBDs

| Actor | Core job Nexus can actually deliver | Big job it supports | Non-negotiable failure condition |
|---|---|---|---|
| Requester/member | Obtain qualified answer, agreed consultation or approved introduction for a concrete need | Grow business / solve problem / learn / find support | Leakage, irrelevant spam, undisclosed failure |
| Home operator, economic buyer | Fulfill otherwise difficult member needs with auditable service level and manageable cost | Membership value, renewals, differentiation | Member ownership lost, admin overload, negative unit economics |
| Provider organization | Accept and serve suitable outside requests within stated capacity/policies | Revenue, partner programs, usefulness to members | Uncompensated overload, poaching, reputational harm |
| Expert/intermediary | Choose whether to perform bounded assistance with context and fair terms | Personal goals, reputation, network, income | Unauthorized demands, excessive pings, public rejection scores |
| Incumbent Community OS | Offer opt-in intercommunity service as a native benefit | Customer LTV, competitive advantage, new premium service | Forced migrations, loss of commercial customer relationship |

### B.2 End-to-end user paths

**Member:** `/help <need>` (or existing `/intro`/`/ask`) → AI/rules propose a compact mission summary → member corrects and approves scope → local verified retrieval → if insufficient, member approves one specific external query tier → operator/partner gateway screening → sealed availability answer or provider offer → mutual approvals → task/consultation/resource delivered → private completion question → optional follow-up. Every stage can be stopped with `/requests`, `/cancel`, `/privacy`, `/forget_me` subject to legitimate retention obligations.

**Home operator:** activate approved source policies or command-only mode → set external partner allowlist and categories → choose operator-auto-review thresholds → resolve or route manually → view dashboard of unresolved, accepted, delivered, unfulfilled missions and cost → grant/revoke partner relationships and report real, attributable results.

**Provider operator:** sign a scoped partnership agreement → publish one or more capability cards under explicit capacity → receive standardized, sanitized requests → accept/decline/price/require clarification → nominate specific eligible opt-in participant privately → finalize approved delivery → receive settlement/credits and performance transparency.

**Platform integrator:** provide its own UX; issue signed assistance envelope via OAuth/approved delegated scopes; receive neutral provider offers; broker consent and service fulfillment over a documented API; retain original brand and member system.

## C. Product primitives and formal domain model

### C.1 Entities

- `Organization`: independent club, association, accelerator, VC portfolio operator, expert group, platform-backed community. Legal identity and policy authority separate from Telegram chat ID.
- `CommunitySpace`: one or more Telegram groups, websites, CRM segments or events under an Organization. A source belongs to one Organization and one approved Space; sharing across spaces is explicit.
- `Principal`: authenticated human or service identity, possibly linked privately to Telegram user. One principal may have different pseudonymous `Membership` instances and roles in different Organizations.
- `Membership`: principal ↔ Organization relation, including revocable roles, benefits and local visibility. No automatically global public membership listing.
- `SourceArtifact`: rights-bearing message/document/transcript and its derived chunks/provenance. All derived facts retain source lineage and revocation status.
- `CapabilityClaim`: a person's opted-in skills/experience with evidence level; never implies availability.
- `CapabilityOffer`: an Organization-authorized promise of a type of help with context, eligibility, capacity, price/cost model, policy, expiry and permitted disclosure.
- `Mission`: versioned request to accomplish a job with target success criteria, context, preferences, classification, scope, deadline/expiry and requester control.
- `AssistanceAgreement`: particular scope of what the platform/provider commits to do; conditions for completion and limits of responsibility.
- `OpportunityEnvelope`: minimal signed organizational routing request referencing opaque mission ID, not raw private chat contents.
- `CandidateOffer`: receiving organization's limited response, possibly anonymous until approval, availability and scope included.
- `ConsentGrant`: granular signed/replay-protected decision by principal or organization to perform one action for one audience and purpose, expiry/revocation tracked.
- `ServiceCommitment`: acceptance of a bounded assistance deliverable with provider, slot/quota reservation, terms, owners, and fallback.
- `FulfillmentCase`: durable multi-party state machine, attempts, operator decisions, statuses, handoffs, deadlines, compensations.
- `OutcomeReceipt`: minimal attestations of offer sent, acceptance, delivery, usefulness; raw notes private and opt-in; verification strength explicit.
- `ExchangeEntry`: service/credit/fee accounting, separated from any securities-transaction commission; reversible double-entry references where financial.
- `GapSignal`: aggregate, thresholded evidence of repeated requests that were not served; only data member/operator approved to aggregate.
- `FederationPartner`: signed gateway identity, published trust metadata, partner policies, permitted categories, revocation state and dispute contact.

### C.2 Required invariants

- **I01** default deny across organization and source boundaries; no unauthenticated bulk federation search.
- **I02** explicit requester-approved external query scope, even if home-community owner approved federation generally.
- **I03** actual contact reveal requires every relevant human approval; source organizations cannot force member consent.
- **I04** separate `capability_claim`, `availability`, `willingness`, and `commitment` state; no automatic upgrades from inferred signals.
- **I05** no permanent cross-organizational person identifier in public envelopes; opaque pseudonyms per exchange or strictly scoped pairwise identifiers only where needed.
- **I06** allowlist partner reachability, purpose binding, expiry, non-forwardable default and hop count ceilings. Each hop needs authorization.
- **I07** no personal/relationship trust score as mandatory public reputation; private, participant-approved post-service feedback only.
- **I08** authorization checked at retrieval, offer creation, before external send, before contact reveal, before delivery, and before every protected client sync; deny on stale policy data.
- **I09** withdrawal halts future processing, invalidates controlled projections and propagates tombstone or deletion requests to partners; disclose limits on past human access/backups.
- **I10** at-most-once *business action acceptance* inside our domain via idempotency + durable state; external Telegram delivery is not genuinely exactly-once. Resolve uncertainty without blind re-send.
- **I11** never guarantee downstream fundraise/hire/sale; completion receipts identify the controllable assistance that was actually performed.
- **I12** helper capacity is a hard constraint, not just a soft relevance score. No commitments exceeding reserved slots.
- **I13** minimize small-cohort inference: do not leak unique individuals via anonymous expert counts, repeated probing or tiny capability categories.
- **I14** independent exit, data export and gateway revocation are built into operator controls.
- **I15** no training or third-party AI transmission of private material without applicable member/owner approvals, provider contracts and data-residency review.
- **I16** sensitive activity logs never contain private raw text; aggregate operational telemetry with short retention where appropriate.

### C.3 Conceptual schema delta

These are **illustrative target tables**; split between a Community DB, Clearinghouse DB and protected vault depending on the deployment model. The old `needs` and `intros` are not silently reused as new federation objects.

```sql
CREATE TABLE organizations (
  id TEXT PRIMARY KEY, legal_label TEXT, brand_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','active','suspended','exited')),
  policy_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE org_memberships (
  organization_id TEXT NOT NULL, local_member_id TEXT NOT NULL,
  role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(organization_id,local_member_id)
);
CREATE TABLE missions (
  id TEXT PRIMARY KEY, home_org_id TEXT NOT NULL, requester_local_id TEXT NOT NULL,
  job_code TEXT NOT NULL, success_criteria_json TEXT NOT NULL,
  private_context_ref TEXT, public_summary TEXT,
  disclosure_policy_json TEXT NOT NULL, status TEXT NOT NULL,
  version INTEGER NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE capability_offers (
  id TEXT PRIMARY KEY, provider_org_id TEXT NOT NULL,
  job_code TEXT NOT NULL, public_description TEXT NOT NULL,
  eligibility_json TEXT NOT NULL, capacity_total INTEGER,
  reserved INTEGER NOT NULL DEFAULT 0, commitment_mode TEXT NOT NULL,
  price_terms_json TEXT, visibility TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE consent_grants (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, actor_ref TEXT NOT NULL,
  action TEXT NOT NULL, audience_ref TEXT NOT NULL, purpose TEXT NOT NULL,
  disclosed_fields_json TEXT NOT NULL, expires_at TEXT NOT NULL,
  revoked_at TEXT, recorded_at TEXT NOT NULL
);
CREATE TABLE federation_exchanges (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, receiving_org_id TEXT NOT NULL,
  envelope_hash TEXT NOT NULL, exchange_state TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL
);
CREATE TABLE service_commitments (
  id TEXT PRIMARY KEY, exchange_id TEXT NOT NULL, capability_offer_id TEXT NOT NULL,
  provider_ref TEXT, deliverable_json TEXT NOT NULL, terms_json TEXT NOT NULL,
  status TEXT NOT NULL, capacity_units INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE outcome_receipts (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, commitment_id TEXT,
  completed_service_code TEXT NOT NULL, evidence_level TEXT NOT NULL,
  requester_confirmed INTEGER, provider_confirmed INTEGER,
  verified_at TEXT, redact_after TEXT
);
```

**Implementation:** add FKs/unique constraints appropriate to actual tenancy; normalize roles/scopes; add immutable event audit separate from deletable PII; encrypted private blobs; outbox and inbox tables; unique keys for reservation; consent version fences. Do not copy this example directly to production without review.

## D. Mission and service state machines

### D.1 Member mission

`draft → confirmed → local_investigation → locally_satisfied | external_permission_needed → routed → offers_available | no_eligible_provider → provider_selected → pending_final_approvals → service_committed → in_delivery → delivered → evaluated → closed`

Each nonterminal state can transition to `cancelled`, `expired`, or `failed_with_explanation` under defined rules; a consent revocation can invalidate open external offers and prevent further protected actions. Provide a status history and handoff owner. Distinguish `suggested_match`, `real_provider_offer`, `accepted_commitment`, and `completed_service` throughout.

### D.2 Provider offer

`draft → approved_by_provider_org → published → eligible → hold_requested → member_willing → reserved → committed → delivered | released | declined | withdrawn | expired`.

Never reserve against an inferred expert or inactive member. Treat reservations as atomic. A failed provider can release capacity and optionally offer a substitute only under the assistance agreement.

### D.3 Consent model

Separate decisions:

1. Member authorizes **local** processing of this mission.
2. Member authorizes **external discovery** with exact disclosed fields and approved network(s) or routing rules.
3. Receiving community authorizes **handling** this type of request and optional further sharing.
4. Specific human helper authorizes **participation**; if warm intro, each intermediary authorizes their personal step.
5. Member authorizes **identity reveal / interaction** with helper.
6. Participants optionally authorize **feedback, recontact and knowledge reuse** separately.

Consent event should bind `actor`, `mission_version`, `purpose`, `audience`, `field_allowlist`, `expiry`, `policy_version`, `recorded_at`, `idempotency_key`, `revocation_version`. Avoid relying on one broad `consented=true` flag.

### D.4 Message reliability

All effects are `intent → pending → dispatching → sent | uncertain | definite_failure → reconciled`. For internal state, enforce unique business keys, transactional outbox and inbox de-duplication. For partner transport, use signed, expiring request IDs and replay cache. For Telegram, a crash after send may leave ambiguity because the API does not provide application-level idempotent sends. Reconcile rather than blindly repeat.

## E. Federation protocol, starting from the smallest useful version

### E.1 Mode progression

- **E0 / Manual gateway:** human operator sends sanitized, authorized mission briefs to approved peers, logs responses and approvals. No independent gateway deployment required.
- **E1 / Managed partner endpoint:** each partner's configuration, policies and capability cards live in a managed tenant, but remain isolated. Partner can approve/decline through bot or operator portal.
- **E2 / Machine-readable signed gateway:** eligible organizations expose standardized discovery and response endpoints, authenticated partner-to-partner. Each runs local authorization and can keep private data at home.
- **E3 / Multi-network interop:** partners can be existing alliances/software platforms; open conformance suite, independent trust registry and governance, possibly multiple trust anchors. No implicit transitive permissions.

### E.2 Example Opportunity Envelope

```json
{
  "schema": "nexus.opportunity.v1",
  "exchange_id": "ex_opaque_random",
  "issuer_org": "https://club-a.example",
  "recipient_org": "https://club-b.example",
  "mission_ref": "mission_exchange_scoped_pseudonym",
  "job": "get_firsthand_advice.enterprise_sales.de",
  "summary": "Seeking a qualified operator with direct experience selling regulated B2B software into German enterprises",
  "criteria": {"experience": "direct", "format": "consultation", "language": ["en","de"]},
  "allowed_fields": ["job","summary","criteria"],
  "purpose": "evaluate_willing_provider",
  "forwarding": "prohibited",
  "max_hops": 1,
  "issued_at": "<ISO timestamp>",
  "expires_at": "<ISO timestamp>",
  "policy_version": 4,
  "idempotency_key": "opaque-deterministic-business-key",
  "signature": "<detached signature or verified signed envelope>"
}
```

The Envelope must omit real Telegram IDs, private member relationships, raw transcripts, contact information and unapproved company details. Validate field-level allowlist before signing/sending. Use per-recipient envelopes to constrain audience and replay.

### E.3 Minimal gateway routes

| Route | Purpose | Auth boundary |
|---|---|---|
| `GET /.well-known/nexus-node.json` | Node endpoint, supported protocol versions, public signing keys, supported categories and policies | Public metadata must reveal no private people or member counts |
| `GET /v1/capabilities` | Approved limited capability categories/aggregate capacity | Scope and anti-enumeration protections |
| `POST /v1/opportunities/inquiries` | Submit sanitized bounded inquiry | Signed organization principal, audience/purpose, quota + replay checks |
| `POST /v1/opportunities/{id}/offers` | Respond with eligible anonymous capability offer | Only responding organization can create |
| `POST /v1/opportunities/{id}/approvals` | Exchange proof of required approvals, scoped and minimal | Verify grants from each authority; avoid exporting raw consent logs |
| `POST /v1/commitments` | Make bounded service agreement and reserve capacity | Transactional check, double confirmation and expiry |
| `POST /v1/commitments/{id}/events` | Provider fulfillment, cancellation and redacted completion status | Actor-authorized transitions, idempotent events |
| `POST /v1/exchanges/{id}/withdraw` | Withdraw permissions, request controlled data cleanup | Authenticated revocation and acknowledge receipt |
| `GET /v1/audit/receipts/{id}` | Minimal exchange receipt for authorized parties | No private text unless explicitly scoped |

Use **webhooks/callbacks** for asynchronous events with JWS signatures, replay prevention and key rotation; do not require recipient to keep a synchronous request open. Version request schemas and publish test vectors. Adopt [A2A](https://a2a-protocol.org/) for interoperable agent task transport where helpful, but retain Nexus-specific schemas for social consent, human participants and legal organizations. [OpenID Federation 1.0](https://openid.net/specs/openid-federation-1_0-final.html) is relevant for multilateral institutional trust, not a substitute for member consent. Consider [OpenPACT](https://github.com/openpactprotocol/openpactprotocol) for delegated authorization patterns, not as an unreviewed drop-in privacy guarantee.

### E.4 Routing and policy algorithm

**Hard filter first:** valid issuer/org relationship → requester export permission → partner allowed category/jurisdiction → beneficiary eligibility → helper capacity → nonforwarding policy → active revocation version → absence of blocking conflict → compatible terms. Any failed hard condition means no eligible route.

**Then rank eligible options** by probability of provider willingness and actual service delivery; expertise evidence; criteria fit; schedule/capacity; attention cost; expected requester benefit; coordination and monetary cost; exposure fairness. Do not expose a numerical trust score, inferred relationship graph or hidden sensitive traits. Explore underutilized but qualified offers under a bounded policy.

**Fallback ladder:** cited answer → home-community qualified service → partner committed expert → bounded panel/office hours → operator-managed sourcing → transparent unresolved outcome. When several missions share a repeatable need, propose a capacity product or collective resource instead of pinging more humans.

### E.5 Federation governance minimum

Define partner constitution: eligibility, use limitations, no unwanted marketing, member ownership attribution, required member approvals, permitted categories, rate and size limits, withdrawal, mutual incident reporting, dispute forum, restrictions on secondary processing, data geography, attribution/credits, commercial terms, security review, portability/termination. A participant can be excluded for violating trust while preserving ongoing lawful member rights.

## F. Deployment architecture and technical choice

### F.1 Recommended strangler architecture

```text
[ Telegram / partner Community OS / website ]
          |
  [Home Organization Gateway / verified principals]
          |
  +------------------- Community Trust Boundary ------------------+
  | LocalKnowledgeAdapter -> approved source ACL -> evidence RAG  |
  | Member-capability vault / private role memberships           |
  | Mission intake + operator approvals + private mission notes  |
  +--------------------------------------------------------------+
          |   restricted sanitized envelope only
          v
  [Opportunity Clearinghouse / federation registry]
  [Capability catalog -> hard-policy routing -> consent broker]
  [capacity reservation -> service orchestration -> receipts]
          | signed narrow protocol
   +------+------+-----------------+
   |             |                 |
[Partner B] [Partner C] [External platform integrator]
   |             |                 |
[Local people & knowledge, controlled by their organizations]
```

**Do not send raw Telegram archives to a central federation search cluster.** Search raw local evidence where it is controlled, produce a permitted answer or limited capability availability response, and transmit only explicitly authorized fields. A shared service may operate as a managed tenant initially, but its data boundaries must be represented explicitly in code and test policy.

### F.2 Data placement choices

- **Current candidate:** Cloudflare Worker + D1 for local community prototype. Preserve where it meets requirement and code already exists. Keep sensitive access in backend; no client replica of full Telegram history.
- **When multiple tenants arrive:** either partition by explicit organization IDs with strict end-to-end policy checks *and* resource isolation, or use one database per tenant plus central clearinghouse metadata. D1 free plan limits mean per-tenant databases across numerous organizations is not a universally free strategy ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)).
- **For atomic reservations:** use a single authoritative transaction boundary; SQLite-backed [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) can act as per-offer reservation coordinators if Cloudflare remains primary. PostgreSQL with transactional constraints is another valid option. Do not use eventually consistent client state as the authority for disclosing identities or consuming capacity.
- **For durable asynchronous orchestration:** current outbox handles simple Telegram effects. Extend to durable workflow records. [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) are an option for external approvals and resumable activities; [Cloudflare Queues](https://developers.cloudflare.com/queues/) use at-least-once delivery, so every consumer must be idempotent and have a dead-letter path.
- **For live reactive member/operator UI:** incremental Mini App views are enough initially. Jazz v2 ([repo](https://github.com/garden-co/jazz)) is a promising independent evaluation for local-first state but explicitly alpha; classic Jazz ([repo](https://github.com/garden-co/classic-jazz)) is legacy. Do not migrate in order to build L1. Sync only authorized projections and carefully test revocation/history/deletion.
- **For fine-grained authorization complexity:** domain service + tested policy can suffice at E0/E1. At E2+, evaluate [SpiceDB](https://authzed.com/docs/spicedb) for organization/space/mission/capability relationships and contextual caveats. Avoid overcomplex policy engines before integration warrants them.
- **For interoperability:** A2A and OpenID Federation play different roles: transport/task and organization metadata trust respectively. OAuth/OIDC supports end-user/application authorization; none by itself establishes social consent.

### F.3 Services / packages

```
worker/src/
  domain/mission.ts              # typed aggregate, versioned job criteria
  domain/capability.ts           # supply offers and capacity policy
  domain/assistance.ts           # assistance agreements, completion rules
  domain/consent.ts              # purpose/audience/fields, signed records
  domain/receipts.ts             # evidence and verification level
  services/mission-compiler.ts   # suggested mission draft, member approves
  services/knowledge-router.ts   # retains current source authorization and citations
  services/eligibility.ts        # deterministic hard gates
  services/matching.ts           # ranking AFTER eligibility
  services/fulfillment.ts        # durable handoff ownership/fallback
  services/exchange-ledger.ts    # accounting and immutable limited audit
  gateways/telegram.ts          # current interface + new commands
  gateways/operator.ts          # approved operator actions
  federation/envelopes.ts       # canonical serialization + signatures
  federation/peer-auth.ts       # valid partner and key checks
  federation/handlers.ts        # signed inbox/outbox, validation, replay
  federation/a2a-adapter.ts     # optional standards adapter
  adapters/legacy-*.ts          # bridge old needs/intros, no silent rewrite
```

These are target module names, not existing files. Extract pure domain rules, use adapters and feature flags. Keep the existing Worker bot functional while new assistance requests are enabled for approved spaces only.

## G. Detailed engineering tracks with acceptance gates

### Track 0: Unmerged draft and security baseline

**Dependencies:** owner approval of actual target repo/branch and operational account ownership. **Actions:** independent audit of PR #145; run CI/tests in an isolated checkout; permission/intro/data-right adversarial review; design decision records for tenant model and data placement; owner-approved privacy notice; group consent notice; zero private data in public GitHub. **Evidence:** CI logs, review signoff, runtime smoke-test, restored encrypted backup, reproducible sample data. **Gate:** do not route real cross-community requests before local identity, ACL, deletion and effects are verified.

### Track 1: Jobs and evidence rather than feature proliferation

**Actions:** collect actual unresolved operator cases; record job, desired success criteria, urgency, existing methods, buyer's spending/budget, privacy sensitivity, real consequence and failure point. Classify cases as `knowledge_answer`, `qualified_expert_review`, `warm_intro`, `reserved_office_hour`, `small_panel`, or `commercial_project` (the last requires added commercial/legal workflows). Test two operator segments that already have assistance budgets; keep unrelated verticals out of scope. **Gate:** observable recurring need and at least one partner willing to make a commitment; buyers make real commercial or operational commitments, not compliments.

### Track 2: Multi-organization identity and scoped access

**Actions:** introduce organizations, spaces, membership, pseudonymous identity mapping, partner statuses and capability provider policies; migrate legacy rows into one explicit home organization in a forward-only, reversible-in-application manner. Add global-person handling only inside a controlled vault. Guard every query with organization context and purpose; forbid cross-tenant scans. **Gate:** negative cross-tenant test suite proves no search, listing, count, direct URL, history or telemetry leakage.

### Track 3: Mission Compiler and operator help desk

**Actions:** add `/help`, `/requests`, `/cancel`, `/offer` and optional `/mission` UI; parse outcome and constraints from text; produce minimal private draft; member explicitly confirms sensitive context and external routing; operator sees only authorized case summary. Route locally to existing `/ask` or `/intro` where adequate. Display a trace of the current owner and status, not an opaque progress spinner. **Gate:** real cases can be filed, updated, cancelled and completed by a human concierge without federation infrastructure, with truthful statuses.

### Track 4: Capability offers and voluntary supply

**Actions:** distinguish verified member skill claims from organization-approved service offers. Add categories, evidence class, available slots, qualification rules, volunteer/paid terms, rejection controls and expiry. Use supplier-onboarding process with test request and consent demonstration. Add reservation transaction; use waitlist only for genuine committed capacity. **Gate:** provider can accept/decline, cap volume, withdraw and close a service; overbooking is impossible within defined concurrency model.

### Track 5: Assistance agreements and multi-party fulfillment

**Actions:** formal assistance deliverables; state machine for intake, investigation, screening, offer, acceptance, booking, actual delivery, feedback, expiry and cancellation; unique handoff owner, idempotency, audit and no duplicate invites. Add automatic fallback to manual coordinator on ambiguous external-send status. **Gate:** requester and provider can accurately reconstruct every meaningful transition; no silent abandoned cases.

### Track 6: Private partner gateway

**Actions:** begin human-mediated requests, then formal partner node config and signed Opportunity Envelopes. Restrict recipients, job categories, fields, purpose, forwarding and expiry. Implement credential rotation, partner revocation, payload anti-enumeration, inbound replay guards, payload schemas and bounded retry. **Gate:** cross-community request can be completed without exporting the originating member's identity, archives, contacts or social graph; malicious partner test is blocked.

### Track 7: Permission and disclosure engine

**Actions:** model requester export, home-operator policy, receiving-operator eligibility, expert choice, intermediary choice, final reciprocal introduction, outcome reuse as independent decisions; build review and revoke views. Purpose changes require new grants. Add conservative defaults and public-facing explanation. **Gate:** no private source, member identity or contact exposed before current, scoped grants from relevant principals; revocation blocks future sends.

### Track 8: Verified assistance and usefulness

**Actions:** post-service receipt with independent member/provider confirmations; treat unverified as unknown, not success. Keep private evaluation private. Record failure reason codes with minimal personal data; sample cases for qualitative audit; business outcome separate from service outcome. **Gate:** no claim such as "successful introductions" based solely on suggested candidates; operator report distinguishes investigated, willing, approved, delivered and useful.

### Track 9: Capacity clearing and viable economics

**Actions:** provider capacity budget, cost per investigation, sourcing hours, helper burden, price/credit settlement, platform and partner attribution; payment optional and jurisdiction/industry restricted. Recurring demand can trigger a staffed group clinic rather than many individual pings. **Gate:** per-job category contribution margin and provider satisfaction measured; stop categories with unsustainable fulfillment or quality.

### Track 10: Federation integrations and conformance

**Actions:** documented protocols, OpenAPI/JSON Schema, A2A adapter if suitable, API keys/OAuth/scopes, examples for external Community OS, an SDK and a simulated second independently deployed node; version policy and conformance tests; partner portability and export. **Gate:** a partner can connect without migrating its member directory; the same test suite runs against an independent implementation.

### Track 11: Adaptive opportunity supply and collective problem-solving

**Actions:** aggregate repeated unresolved needs under anonymity thresholds; recruit specialist organizations, commission office hours, enable opt-in small teams and Pol.is-inspired independently collected expert judgment on appropriate topics. Public knowledge artifacts require separate consent and provenance. **Gate:** demonstrate a newly created capability that serves a formerly unserved job with acceptable cost/quality, not mere attendance.

### Track 12: Governance and independent federation maturity

**Actions:** partner constitution, key-trust framework, independent incident/appeal handling, code of conduct, conflict-of-interest procedures, data-residency options, federation-to-federation compatibility, financial audit, neutral ranking disclosure, operating budget and partner exit tests. **Gate:** independent operators can join, use, leave or substitute their gateway without losing unrelated local service or members.

## H. Vertical-slice and release graph

| Slice | Observable user moment | Dependencies | Required gate | Do not build yet |
|---|---|---|---|---|
| S0 Source-cited local help | Member asks, gets authorized cited answer/no-evidence response | Existing source ACL, search, Telegram | No restricted citation; real group notice/owner approval | Global source search |
| S1 Private mission submission | Member submits and approves concise Job Card | Identity, operator case queue | No sensitive data auto-export | Universal profile |
| S2 Local completion | Operator delivers first approved answer/introduction and completion receipt | Existing intro state machine, case lifecycle | Recorded actual service; refusal handled | Federation protocol |
| S3 Supplier offer | Specialist community publishes a bounded authorized assistance capability | Tenant model, provider policy, capacity | Commitments cannot overbook | Massive expert directory |
| S4 Human brokered cross-community request | One member's approved query reaches one eligible partner, provider voluntarily helps | Consent, field scopes, signed/mock envelope | No identity/source leak, auditable state | Automated multi-hop |
| S5 Managed partner gateway | Two organizations use different policies with a shared clearing service | Organization trust, external idempotency | Revocation, exit, abuse control tests | Full decentralization |
| S6 Portable gateway | Independently hosted partner interoperates | Federation API, conformance | No central raw-data dependency, key rotation | Tokens/blockchain |
| S7 Capacity intelligence | Recurring gap creates a new provider/office-hour capability | S5+ outcomes + aggregation safeguards | Genuine fulfillment uplift, sustainable cost | Autonomous unsolicited sourcing |
| S8 Protocol ecosystem | External platform/alliances embed gateway and commercial exchanges | Neutral governance + SDK | Independent adoption and positive partner economics | Consumer social platform |

**Key sequencing rule:** each slice must deliver an independently useful, authorized result and retain end-to-end rollback semantics. Do not wait for S8 to make S1–S4 valuable; do not claim S8 because S4 succeeds.

## I. Repository-level execution plan and suggested PR boundaries

- **RFD-001:** State the product category, purchaser/job, non-goals and success criteria. Update `README.md`, `MASTER_PLAN.md`, privacy docs. Link all claims to evidence or mark hypothesis.
- **ADR-001:** Decide authoritative business domain model (D1 initially vs PostgreSQL vs Durable Object coordination), tenancy boundary, ownership and incident model. Preserve portability.
- **ADR-002:** Specify privacy/data classes and disclosure stages including federation, deletion lineage, retention and backup policy.
- **PR-0:** Close independent audit and local trial gates on existing open PR #145. Do not merge without owner authority and reviewed evidence. Record tests and reviewed commit.
- **PR-1:** Add `organizations`, `org_memberships`, `spaces`, member-scope and organization-role data; typed `OrgContext`, explicit `actor`, `purpose`, deny-default auth helpers. Add negative tests and migration checks.
- **PR-2:** Add mission/assistance domains, new tables, migrations, `/help` and operator `/desk`; reuses `search` and local `intros`. Ensure no LLM needed for first slice.
- **PR-3:** Add capability offers and capacity ledger + approval UI; no federation calls needed.
- **PR-4:** Add consent grant records and external disclosure preview, route planner in dry-run mode, revocation cascade and human supervisor workflow.
- **PR-5:** Add manual-gateway federation cases and standardized envelope generation + audit, partner restricted workflow; two organizations simulated.
- **PR-6:** Add signed federation transport + inbox/outbox, key management, anti-replay, payload limits, rate limiting, expiry, per-partner routing policies and SSRF defense.
- **PR-7:** Add multi-party fulfillment, completion receipts, provider and requester feedback separated; operator report with verified states.
- **PR-8:** Add standardized node manifest, OpenAPI contracts, SDK, conformance tests and example external gateway implementation.
- **PR-9:** Add clearing ledger, approved paid programs, receipts, reconciliation and suitable service-specific billing.
- **PR-10:** Add demand aggregation and bridge-creation recommendation queue, independent-first expert panels if specific repeated jobs justify them.

Every PR requires: typed contracts, actual negative security tests, migration replay test, backward compatibility for existing commands, privacy review, observability, owner acceptance, and demonstration of the specific new user job completed. Stop unrelated feature work where it displaces a critical gate.

### I.1 Proposed repo structure

```
README.md
MASTER_PLAN.md
architecture/
  constitution.yaml
  ADR-001-database-and-tenancy.md
  ADR-002-data-disclosure-and-consent.md
  ADR-003-federation-trust-model.md
  threat-model.md
contracts/
  nexus-opportunity-envelope.schema.json
  nexus-capability-offer.schema.json
  nexus-consent-proof.schema.json
  nexus-outcome-receipt.schema.json
  openapi.yaml
worker/src/
  domain/                 # pure invariants and state machines
  application/            # mission planner, fulfillment, policy services
  adapters/               # Telegram, storage, matching, knowledge, providers
  federation/             # signed transport, schemas, anti-replay
  bot/                    # existing Telegram entry adapted without regressions
worker/migrations/
  0005_organization_boundary.sql
  0006_missions_and_assistance.sql
  0007_capabilities_and_commitments.sql
  0008_consent_and_federation.sql
  0009_receipts_and_accounting.sql
worker/test/
  tenant-isolation.test.ts
  federation-auth.test.ts
  consent-propagation.test.ts
  capacity-race.test.ts
  partner-withdrawal.test.ts
  no-inferred-contact-disclosure.test.ts
  workflow-recovery.test.ts
  private-data-erasure.test.ts
  independent-gateway-contract.test.ts
docs/
  PARTNER_CONSTITUTION.md
  PRIVACY.md
  OPERATOR_GUIDE.md
  RUNBOOK_FEDERATION.md
  SERVICE_CATALOG.md
  PERFORMANCE_AND_ECONOMICS.md
```

Exact names and migration numbers are illustrative and must be reconciled with current repository migrations and existing PRs.

## J. Security, abuse, compliance and adversarial testing

### J.1 Threats and mitigations

| Threat | Attack example | Required defense and acceptance |
|---|---|---|
| Cross-community data bleed | Member of Org A retrieves Org B excerpt via query/API/cache | Explicit source + tenant authorization at retrieval time; negative tests, no global raw index |
| Capability membership inference | Partner probes rare qualifications to identify one person | Coarsen capability categories, suppress counts, query budgets, signed purpose, no name reveal |
| Unauthorized onward disclosure | Provider forwards request to multiple partners | Nonforwardable envelope by default; no further hops without requester/org grant, gateway logging |
| Spoofed federation node | Attacker impersonates an association | Allowlisted keys, signatures and key rotation, trust registry; signed audience and expiry |
| Replay/double booking | Same packet accepted twice, capacity overbooked | Unique idempotency, transactional slot reservation and status version fences |
| Prompt injection through chats or envelopes | Message instructs AI to expose contacts | Untrusted content as data only, tool authorization outside models, no automatic external effects |
| AI skill hallucination | System declares member competent based on posts | Separate self-claim, provenance evidence and availability; human ability to reject |
| Expert harassment and fatigue | Many near-identical requests target scarce provider | Provider capacity hard limits, routing quotas, demand aggregation, stop-contact controls |
| Covert marketing/member poaching | Platform/partner uses received details for solicitation | No bulk directory, contract enforcement, purpose-limited IDs, incident process, operator traceability |
| Deletion laundering | Derived summarization hides revoked sensitive source | Provenance graph, invalidation scheduler, revocation gate in retrieval and federation, partner cleanup acknowledgement |
| Disputed outcome | Platform counts intro as business sale | Separate service and business outcomes, verification levels, private participant confirmations |
| Transaction-based regulated referrals | Compensation from securities capital raised | Exclude by default pending specialist jurisdictional counsel; allow only lawful services/program fees |
| Client sync exposure | Replica retains material after loss of permission | Never replicate raw sensitive vault data broadly; revoke new reads; document past-copy limits |
| Partner supply fakery | Node advertises 1,000 specialists without commitment | Only verified bounded capacity gets commitment mode; audit eligibility and performance |

### J.2 Tests: minimum red-team suite

- Tenant matrix: requester in A, provider in B, neither in C; every role/source/action combination, including search metadata, counts, citations, cache, logs, export.
- Revoke race: member withdraws permission just before envelope dispatch, before helper accept, before contact reveal, during booking, after service; expected effects recorded.
- Stale mission: a signed offer for mission version N cannot approve mission version N+1 with new sensitive context.
- Repeated probing: malicious partner uses slight variants to infer a specialist; bounded/no disclosure.
- Duplicate effects: retries, queue redelivery and simulated crash around external send; never lose state or silently double-count.
- Concurrent provider reservation: two commitments for final capacity slot yield only one authorized result.
- Invalid keys: expired, revoked, wrong-audience, unknown issuer, forged body, wrong policy version, reused nonce all fail.
- Fake provider: claims experience but no human willingness; routing returns uncommitted/unknown not "available".
- Incident shutdown: entire partner gateway disabled with continuing local `/ask` availability.
- GDPR/other appropriate rights handling: deletion, access, portability and documented retention/processor constraints for relevant jurisdictions.
- Workload exhaustion: provider quota + rate limits + backpressure preserve overall system health.

## K. Business model and actual operator offer

### K.1 Three commercial packages to test

**Community Assistance Desk:** branded local concierge for qualified member requests, governed knowledge reuse, outcome reporting and optional managed coordination. Price by operator service obligations, request-volume tier and committed staff capacity, not arbitrary contact counts.

**Federation Access + Capability Exchange:** connection to approved complementary communities, eligibility-based external routing, access to vetted programs, trusted exchange controls, optional operator-level partner settlement. Free/basic discovery may lower adoption friction but must carry request limits and a sustainable supply model.

**Embedded Platform/API:** a neutral white-label gateway sold/resold by established Community OS vendors and alliances, with transparent usage/pricing and no forced migration; documentation and conformance as enterprise deliverables.

**Supply products:** paid specialist clinics, approved consulting slots, partner programming and carefully regulated service marketplaces. Never assume capital-raising compensation or restricted referral economics are legally available.

### K.2 Founding offer

"**Your community shouldn't run out of ways to help.** Bring one of the member requests you couldn't resolve. We investigate eligible, willing support through complementary trusted communities with your and the member's consent. No membership migration, contact upload or undisclosed data exchange. If the assistance and its cost are useful, expand to an ongoing service."

Promise only available deliverables: qualified intake, bounded investigation, a definite accept/decline outcome, or a pre-contracted service when actual capacity exists. After supply is established, stronger response/consultation guarantees can be tested, priced and honored. Do not guarantee fundraises, customer conversion or a specific human introduction.

### K.3 Partner economics / contribution ledger

- Track opportunity origination, screening costs, expert capacity utilization, commitments, completed paid services, cancellations/credits and dispute resolution.
- Provider community can set `volunteer`, `paid`, `reciprocal`, `private_member_benefit` terms; billing only if separately approved.
- Home operator retains customer relationship and branding; provider operator retains admission control and expert relationship; Nexus earns infrastructure/coordination fees if it genuinely provides value.
- Use aggregate exchange balances as a fairness diagnostic, not a public individual social score. Specialist providers may receive money, projects or program seats rather than symmetric intros.
- Account for human concierge cost, expert cost, gateway processing, retry burden, privacy/compliance and operator onboarding in unit economics.

## L. Measurement, experimental design and go/no-go

### L.1 North star and funnel

Primary: **incremental qualified-assistance completion per eligible mission**. Report local-only and cross-community versions separately and, where feasible, use matched allocation or a pre-registered comparison. Not all help episodes have a binary downstream business result; distinguish service completion from actual member impact.

Funnel states: eligible missions → valid job cards → locally resolved → requested federation → partner accepts inquiry → willing helper offers → both approve → committed service → delivered service → member useful → independently verified outcome. For all states preserve denominators and elapsed stage latency, without blending partial and terminal statuses.

### L.2 Metrics by constituency

- **Member:** job criteria met, useful service rate, effort to ask/approve, unsanctioned contact reports, recontact consent rate.
- **Home operator:** unresolved backlog, helpful outcomes/eligible request, manual minutes per completed episode, renewal/retention **association not automatically causation**, revenue/paying pilot conversion.
- **Provider:** eligible demand, acceptance/decline rate, workload, completion rate, satisfaction, per-slot compensation or exchange utility.
- **System:** no unauthorized disclosure; revocation propagation; duplicate send reconciliation; median/percentile handoff latency; contribution margin; incident count.
- **Federation:** uplift over local route for comparable cases, incremental capability coverage, partner concentration, effective supply versus nominal member count, underrepresented provider coverage.

### L.3 Indicative gates, to be calibrated from real job data

- **Gate G0 (privacy):** zero known critical unauthorized disclosure in test and pilot; any critical incident stops external routing pending remediation.
- **Gate G1 (buyer/job):** actual paying decision maker authorizes a bounded service test; clear repeated and costly member jobs evidenced from recent cases.
- **Gate G2 (supply):** receiving organizations make real, auditable bounded participation commitments; the "expert exists" claim alone does not count.
- **Gate G3 (delivery):** multiple real member requests reach actual service or clearly explained terminal no-match, with no abandoned silent transitions.
- **Gate G4 (federation uplift):** credible comparative evidence that partner access improves useful completion beyond local-only approaches. A mere number of nodes or intro attempts cannot satisfy this gate.
- **Gate G5 (economics):** positive contribution margin under realistic staffing and capacity conditions, or justified deliberate subsidy with explicit ceiling.
- **Gate G6 (integrations):** an independent partner implementation passes contract, security and withdrawal tests without exporting member directory.
- **Gate G7 (scale):** repeatable partner acquisition without worsening service quality, privacy incidents or supplier burnout.

When a gate fails, diagnose upstream before adding AI, more search or marketing spend. Use NMT/JTBD interviews with buyers, rejected providers and dissatisfied members, not only fans of the prototype.

### L.4 Highest-risk hypotheses

1. There are enough **high-consequence recurring needs** across the chosen operator segment to fund a service.
2. Operators will authorize external cooperation under a credible sovereignty and trust agreement.
3. Provider organizations will expose *real willing capacity* at sustainable terms.
4. A federation materially improves assistance compared with organizer search/local directory/human referrals.
5. Cases can be completed with reasonable attention expense and sufficient success rates.
6. Buyers will pay the actual cost of a sustainable service, not merely praise the idea.
7. Signed, scoped cross-organization workflows can remain reliable when the participant systems are independently administered.

Prioritize falsification by consequence, probability and test cost, with unknown probabilities explicitly marked as estimates, not facts. Avoid multiplying unvalidated assumptions by building the whole system first.

## M. Research, positioning and adoption

### M.1 Job-based entry segment

Prefer operators who already have a budget/responsibility for helping members: managed paid business clubs, accelerator/VC portfolio support, international chambers and specialist associations. Segment by *how they currently handle unresolved requests and what counts as success*, not nationality or club brand. Initial service can serve non-startup needs when same job mechanics apply, but don't flatten fundamentally different domains.

### M.2 Suggested JTBD interviews

Ask about the last actual unresolved member case: trigger, desired outcome, criteria, current workaround, people contacted, handoffs, total effort, consequences, why existing solution was chosen, fears about outside partners, actual buyer, budget, purchase approvals. Then present a concrete consent-preserving paid concierge offering and ask for operational commitment. Do not ask “Would you like a six-degrees AI network?”

### M.3 Messaging hierarchy

**Member:** “Ask once. Get credible help or a clear next step.” / RU: «Есть задача? Найдём тех, кто уже через это прошёл». 

**Operator:** “Your community shouldn't run out of ways to help.” / RU: «Ваш клуб остаётся вашим. Возможностей для резидентов становится больше».

**Provider:** “The right requests, on your terms.” / RU: «Только релевантные запросы. Ваши правила и загрузка».

**Platform:** “Extend your community OS, don't replace it.”

Tone: practical, specific, trust-led, clear about limits. Existing research found that EN founders value customers/qualified intros, RU club operators speak of «закрыть запрос», «по делу», «проверенные», and Chinese business networks emphasize 精准对接 and 资源对接. These are research hypotheses for messaging; validate with real customers and never copy third-party testimonials without permission.

## N. Contradictions resolved by the chosen architecture

- Reach/privacy: advertise capabilities, not unrestricted people; progressive permission-bound reveal.
- Trust/weak ties: discover broadly through organizations, commit narrowly through willing humans.
- Scope/focus: standardized assistance primitive with narrow launch category and real partner supply.
- Free access/economics: separate open/basic network participation from priced managed service and committed capacity.
- Local authority/federation: independent organization policy engine and encrypted/restricted gateway exchange, not central shared archives.
- Fast UX/slow trust: immediate clear mission + local answer while external approvals proceed transparently; never pre-reveal private info.
- AI speed/human judgment: models draft and rank; deterministic consent/policy/financial guards authorize effects.
- Matching quality/expert burn: knowledge-first, capacity budgets, group offerings, rate controls.
- Strong promises/uncertain outcomes: defined service agreements and verified completion receipts, not guarantees of commercial success.
- Network growth/member poaching: home operator retains relationship, partner gets bounded demand; neutral platform governance and no secondary solicitation.

## O. External primary sources and reuse references

**Current Telepathy candidate:**
- https://github.com/shapefuture/Telepathy
- https://github.com/shapefuture/Telepathy/pull/145
- https://github.com/shapefuture/Telepathy/blob/claude/vibrant-curie-7qfs74/architecture/constitution.yaml
- https://github.com/shapefuture/Telepathy/blob/claude/vibrant-curie-7qfs74/worker/migrations/0001_init.sql
- https://github.com/shapefuture/Telepathy/blob/claude/vibrant-curie-7qfs74/worker/src/intros.ts
- https://github.com/shapefuture/Telepathy/blob/claude/vibrant-curie-7qfs74/worker/src/rights.ts

**Core product method:**
- https://github.com/zamesin/Next-Move-Theory-Canon-and-Skills
- https://github.com/katokuneva-tech/jtbd-interviewer
- https://github.com/katokuneva-tech/jtbd-analyst

**Intent, consent and cooperation references:**
- https://github.com/indexnetwork/index (MIT, examine code and exact component boundaries)
- https://github.com/chrisroge/agent-rendezvous (AGPL code, separate protocol licensing)
- https://github.com/openpactprotocol/openpactprotocol (Apache-2.0 reference implementation)
- https://github.com/nickzasukhin/ai-agents-p2p (license for code reuse requires verification)
- https://github.com/compdemocracy/polis (AGPL collaborative opinion clustering)
- https://a2a-protocol.org/ (official agent-to-agent standard)
- https://openid.net/specs/openid-federation-1_0-final.html (organization trust chains and trust marks)
- https://authzed.com/docs/spicedb (relationship and context authorization)

**Telegram and Cloudflare infrastructure:**
- https://core.telegram.org/bots/faq
- https://core.telegram.org/bots/webapps
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
- https://developers.cloudflare.com/workflows/

**Optional local-first/sync and memory:**
- https://github.com/garden-co/jazz (Jazz v2 alpha; do not assume current suitability for protected archives)
- https://github.com/garden-co/classic-jazz (legacy)
- https://powersync.com/
- https://rxdb.info/
- https://github.com/IlyaGusev/tg_chat_search
- https://github.com/TencentCloud/TencentDB-Agent-Memory

**Market/category references:**
- https://alliance-clubs.com/
- https://key.ai/
- https://happenstance.ai/for/communities
- https://mabuntu.com/
- https://www.shopify.com/collective (complementary provider distribution precedent)

---

## P. The decisive first action and stopping rule

**First action:** create a read-only formal audit/ADR of PR #145 and a manual **Unsolved Request Desk** grounded in an approved community's actual recent unresolved member jobs. Use the existing local `/ask` and consent intro engine where possible. Ask partner organizations to make narrow, real capability commitments and test one sanctioned external assistance exchange before automating federation.

**Stop/revise:** if real operators lack budget, supply organizations refuse participation, members reject controlled external disclosure, completed assistance has no incremental usefulness, or helper economics are unsustainable, narrow the job and segment rather than growing the feature set. Do not progress to open protocol/public scale while hard trust gates fail.

**End state:** independent organizations can advertise willing capacity, exchange limited needs securely, complete voluntary services, transparently account for value and create new capability where shared demand justifies it. Members remain primarily attached to the communities they trust. Nexus becomes interoperable infrastructure, not the owner of everyone's relationships.
