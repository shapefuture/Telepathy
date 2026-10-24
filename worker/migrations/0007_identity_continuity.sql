-- Continuity (CONT-1..9): community identity, independent person identity, consented follows,
-- verified delivery channels, membership attestations, recovery drills.
-- Purely additive. Existing members are NOT enrolled automatically: every row below is created
-- by a person's own action (or an operator's for attestations/identity).

-- CONT-1: the club's verifiable identity. Root metadata is signed offline by a threshold of
-- custodian keys; it delegates to the Worker's online key, which signs destination manifests.
CREATE TABLE community_identity (
  org_id TEXT PRIMARY KEY DEFAULT 'home',
  stable_id TEXT NOT NULL,                 -- e.g. "club-a" (never a chat id)
  root_json TEXT NOT NULL,                 -- current signed root metadata
  root_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE destination_manifests (
  version INTEGER PRIMARY KEY,             -- strictly increasing: no rollback
  json TEXT NOT NULL,                      -- signed manifest
  relocation INTEGER NOT NULL DEFAULT 0,   -- 1 when it moves the primary address (root-signed)
  published_at TEXT NOT NULL
);

-- CONT-2/3: a person independent of Telegram. Linked to a Telegram member only with proof
-- (signed Mini App initData = proof of the current Telegram session).
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE TABLE identity_links (
  person_id TEXT NOT NULL REFERENCES people(id),
  platform TEXT NOT NULL CHECK (platform IN ('telegram')),
  account_id TEXT NOT NULL,                -- members.id for telegram
  proof_method TEXT NOT NULL,              -- 'telegram_init_data'
  proof_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (platform, account_id)
);
CREATE INDEX identity_links_person ON identity_links(person_id);

-- Independent login factors. Email codes and recovery codes are stored as HMACs only.
CREATE TABLE login_codes (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify','login')),
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE recovery_codes (
  person_id TEXT NOT NULL REFERENCES people(id),
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (person_id, code_hash)
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  method TEXT NOT NULL,                    -- email_code | recovery_code
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

-- CONT-4: delivery channels. The address is encrypted (AES-GCM); lookups use a keyed hash.
CREATE TABLE delivery_registrations (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  channel TEXT NOT NULL CHECK (channel IN ('email','telegram')),
  address_enc TEXT,                        -- NULL for telegram (resolved via identity_links)
  address_hash TEXT NOT NULL,             -- keyed HMAC, for lookups on this node
  suppress_hash TEXT NOT NULL,             -- sha256(channel:address), portable across installs
  status TEXT NOT NULL CHECK (status IN ('pending','verified','revoked')),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (channel, address_hash)
);
CREATE INDEX delivery_person ON delivery_registrations(person_id, status);

-- Follow intents per purpose, as a versioned operation log. State = latest op per (person, topic);
-- a restore can never replace a newer op with an older one.
CREATE TABLE subscription_ops (
  person_id TEXT NOT NULL REFERENCES people(id),
  seq INTEGER NOT NULL,                    -- per person, strictly increasing
  op TEXT NOT NULL CHECK (op IN ('FOLLOW','UNFOLLOW','MUTE','UNMUTE','REVOKE_ENDPOINT')),
  topic TEXT,                              -- critical|events|requests|news|commercial|partner_offers
  registration_id TEXT,
  consent_version INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (person_id, seq)
);
CREATE TABLE follow_state (
  person_id TEXT NOT NULL REFERENCES people(id),
  topic TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('following','muted','unfollowed')),
  seq INTEGER NOT NULL,
  PRIMARY KEY (person_id, topic)
);
-- Minimal tombstones: hashes of addresses that withdrew, so no import or restore re-enables
-- them. Purpose-limited (suppression only); no names, no text. Unkeyed SHA-256 so they survive
-- a move to a new install with a different key (trade-off documented in PRIVACY.md).
CREATE TABLE suppressions (
  address_hash TEXT NOT NULL,              -- = delivery_registrations.suppress_hash
  scope TEXT NOT NULL,                     -- topic or '*'
  created_at TEXT NOT NULL,
  PRIMARY KEY (address_hash, scope)
);

-- CONT-7: membership attestations issued (and revoked) by the club.
CREATE TABLE membership_attestations (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  tier TEXT NOT NULL,                      -- member | resident | <custom>
  scope TEXT NOT NULL DEFAULT 'community',
  status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')),
  basis TEXT NOT NULL,                     -- 'group_access' | 'operator'
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX attestations_person ON membership_attestations(person_id, status);

-- CONT-6: continuity alerts, one delivery per (alert, person, channel).
CREATE TABLE continuity_alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('relocation','incident','drill')),
  manifest_version INTEGER,
  message TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE alert_deliveries (
  alert_id TEXT NOT NULL REFERENCES continuity_alerts(id),
  person_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','sent','failed','suppressed','confirmed')),
  token_hash TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (alert_id, person_id, channel)
);

-- CONT-9: recovery drills with observed results (confirmed, not merely queued).
CREATE TABLE recovery_drills (
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL CHECK (scenario IN ('telegram_down','nexus_down','domain_down')),
  alert_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  invited INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

-- CONT-8: verified relocation notices received from partners, served by our rescue relay.
CREATE TABLE relay_notices (
  partner_id TEXT PRIMARY KEY,
  manifest_version INTEGER NOT NULL,
  json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
ALTER TABLE organizations ADD COLUMN root_json TEXT;   -- partner's pinned root metadata
