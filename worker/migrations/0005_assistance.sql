-- Opportunity Internet L1/L2 (ADR-001..003). One Worker deployment = one organization node.
-- Partners are other nodes; nothing here stores another organization's members or archives.

-- Organizations: exactly one 'home' row (this node) plus allowlisted federation partners (I01, I06).
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,                     -- 'home', or the partner's node id (its https origin)
  kind TEXT NOT NULL CHECK (kind IN ('home','partner')),
  brand_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','suspended','exited')),
  endpoint TEXT,                           -- partner https base URL (NULL = manual E0 gateway)
  public_key TEXT,                         -- partner Ed25519 raw public key, base64
  categories TEXT NOT NULL DEFAULT '[]',   -- JSON job codes allowed both ways; ["*"] = any
  policy_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
INSERT INTO organizations(id, kind, brand_label, created_at) VALUES ('home', 'home', 'Community', strftime('%Y-%m-%dT%H:%M:%SZ','now'));

-- Every source belongs to exactly one organization; today always the home node.
ALTER TABLE sources ADD COLUMN org_id TEXT NOT NULL DEFAULT 'home';

-- Missions (D.1). Distinct from legacy `needs`, which keep working for /intro.
CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  job_code TEXT NOT NULL,
  summary TEXT NOT NULL,                   -- member-approved text; the only free text that may leave
  criteria TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,      -- bumps when the summary changes; fences consent (J.2 stale mission)
  handler TEXT NOT NULL DEFAULT 'member',  -- current owner of the next step: member | operator | partner
  local_hits INTEGER NOT NULL DEFAULT 0,
  reason TEXT,                             -- explanation for failed_with_explanation / no provider
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX missions_member ON missions(member_id, status);
CREATE INDEX missions_status ON missions(status, updated_at);

CREATE TABLE mission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,                     -- member | operator | system | partner
  at TEXT NOT NULL
);
CREATE INDEX mission_events_mission ON mission_events(mission_id, id);

-- Capability offers (C.1): organization-authorized promises with hard capacity (I04, I12).
CREATE TABLE capability_offers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'home' REFERENCES organizations(id),
  job_code TEXT NOT NULL,
  description TEXT NOT NULL,
  capacity_total INTEGER NOT NULL CHECK (capacity_total >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  commitment_mode TEXT NOT NULL DEFAULT 'volunteer' CHECK (commitment_mode IN ('volunteer','paid','reciprocal','member_benefit')),
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','withdrawn','expired')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (reserved <= capacity_total)
);
CREATE INDEX capability_offers_job ON capability_offers(job_code, status);

-- Consent grants (D.3): one row per decision, bound to mission version, audience and fields.
CREATE TABLE consent_grants (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('local','external_discovery','reveal','feedback')),
  audience TEXT NOT NULL,                  -- 'home' or JSON array of partner org ids
  purpose TEXT NOT NULL,
  fields TEXT NOT NULL DEFAULT '[]',       -- JSON field allowlist
  mission_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  recorded_at TEXT NOT NULL,
  UNIQUE (mission_id, action, mission_version)
);

-- Federation exchanges: one per (mission, partner) out, or per received inquiry in.
CREATE TABLE federation_exchanges (
  id TEXT PRIMARY KEY,                     -- our exchange id (opaque, random)
  direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  partner_id TEXT NOT NULL REFERENCES organizations(id),
  mission_id TEXT,                         -- set for 'out' only; never sent
  remote_id TEXT,                          -- the partner's exchange id ('in')
  mission_ref TEXT NOT NULL,               -- per-exchange pseudonym (I05)
  job_code TEXT NOT NULL,
  summary TEXT NOT NULL,
  envelope TEXT NOT NULL,                  -- signed JSON as sent/received
  state TEXT NOT NULL,                     -- out: prepared|sent|offered|selected|committed|delivered|declined|withdrawn|expired
                                           -- in:  received|offered|committed|delivered|declined|withdrawn|expired
  capability_offer_id TEXT,                -- 'in': which of our offers we proposed
  contact TEXT,                            -- 'in': requester contact, only after a reveal grant
  idempotency_key TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (partner_id, remote_id)
);
CREATE INDEX federation_exchanges_mission ON federation_exchanges(mission_id);

-- Offers received from partners for our outbound exchanges (anonymous until approvals).
CREATE TABLE exchange_offers (
  id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL REFERENCES federation_exchanges(id),
  summary TEXT NOT NULL,
  terms TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','selected','declined','withdrawn')),
  created_at TEXT NOT NULL,
  UNIQUE (exchange_id)
);

-- Service commitments: a reserved slot for one mission (local) or one inbound exchange (provider side).
CREATE TABLE service_commitments (
  id TEXT PRIMARY KEY,
  mission_id TEXT,                         -- local mission, or NULL for inbound partner requests
  exchange_id TEXT,
  capability_offer_id TEXT,                -- NULL when the slot is held by a partner
  status TEXT NOT NULL CHECK (status IN ('committed','in_delivery','delivered','released','cancelled')),
  capacity_units INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- At most one live commitment per mission and per exchange.
CREATE UNIQUE INDEX service_commitments_mission ON service_commitments(mission_id) WHERE mission_id IS NOT NULL AND status IN ('committed','in_delivery');
CREATE UNIQUE INDEX service_commitments_exchange ON service_commitments(exchange_id) WHERE exchange_id IS NOT NULL AND status IN ('committed','in_delivery');

-- Outcome receipts (I11): what assistance actually happened, and who confirmed it.
CREATE TABLE outcome_receipts (
  mission_id TEXT PRIMARY KEY,
  commitment_id TEXT,
  service_code TEXT NOT NULL,              -- knowledge_answer | local_service | partner_service | no_provider
  provider_confirmed INTEGER,
  requester_useful INTEGER,                -- NULL = unknown, never counted as success
  evidence_level TEXT NOT NULL DEFAULT 'unverified' CHECK (evidence_level IN ('unverified','requester_confirmed','provider_confirmed','both_confirmed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Signed federation messages leave through their own ledger (D.4), like Telegram effects.
CREATE TABLE fed_outbox (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  partner_id TEXT NOT NULL,
  path TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','dispatching','sent','uncertain','failed','manual','reconciled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX fed_outbox_state ON fed_outbox(state, created_at);

-- Inbound replay cache (I06, J.2 invalid keys / reused nonce).
CREATE TABLE fed_nonces (
  issuer TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (issuer, nonce)
);
