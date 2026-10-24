-- Hydra (P16, docs/HYDRA_PLAN.md): more independent paths, measured by failure domain, that
-- regrow after a loss. Purely additive for data; two tables are rebuilt only to widen CHECKs.
-- Nobody is enrolled in anything new: every head below is added by the person themself.
PRAGMA defer_foreign_keys = true;

-- H0/H1: delivery heads beyond email and Telegram. `domains` is the JSON list of failure
-- domains the head depends on (computed when verified; e.g. ["mail:google"]). `meta_enc` holds
-- sealed channel data (Web Push keys, a Matrix DM room id).
CREATE TABLE delivery_registrations_new (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  channel TEXT NOT NULL CHECK (channel IN ('email','telegram','webpush','ntfy','matrix','sms')),
  address_enc TEXT,
  address_hash TEXT NOT NULL,
  suppress_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','verified','revoked')),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  domains TEXT,
  meta_enc TEXT,
  health TEXT NOT NULL DEFAULT 'ok' CHECK (health IN ('ok','failing','dead')),
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_ok_at TEXT,
  last_fail_at TEXT,
  UNIQUE (channel, address_hash)
);
INSERT INTO delivery_registrations_new(id, person_id, channel, address_enc, address_hash, suppress_hash, status, verified_at, created_at)
  SELECT id, person_id, channel, address_enc, address_hash, suppress_hash, status, verified_at, created_at FROM delivery_registrations;
DROP TABLE delivery_registrations;
ALTER TABLE delivery_registrations_new RENAME TO delivery_registrations;
CREATE INDEX delivery_person ON delivery_registrations(person_id, status);

-- H7: drills gain the monthly "head off" kind (one channel disabled for a test cohort).
CREATE TABLE recovery_drills_new (
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL CHECK (scenario IN ('telegram_down','nexus_down','domain_down','head_off')),
  alert_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  invited INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  channel TEXT,                            -- head_off: the channel switched off
  incident_id TEXT                         -- the drilled incident (regrowth is measured on it)
);
INSERT INTO recovery_drills_new(id, scenario, alert_id, started_at, ended_at, invited, confirmed, notes)
  SELECT id, scenario, alert_id, started_at, ended_at, invited, confirmed, notes FROM recovery_drills;
DROP TABLE recovery_drills;
ALTER TABLE recovery_drills_new RENAME TO recovery_drills;
CREATE TABLE drill_cohort (
  drill_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  PRIMARY KEY (drill_id, person_id)
);

-- H2: login without Telegram or email. A short public passport id lets a person name
-- themself on a login page; TOTP secrets are sealed; device keys are public JWKs only.
ALTER TABLE people ADD COLUMN handle TEXT;
CREATE UNIQUE INDEX people_handle ON people(handle) WHERE handle IS NOT NULL;
ALTER TABLE people ADD COLUMN guardian_k INTEGER NOT NULL DEFAULT 0;
CREATE TABLE login_factors (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  kind TEXT NOT NULL CHECK (kind IN ('totp','device_key')),
  secret_enc TEXT,                         -- totp: sealed base32 secret
  public_jwk TEXT,                         -- device_key: ECDSA P-256 public key
  label TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
  last_step INTEGER NOT NULL DEFAULT 0,    -- totp replay guard
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX login_factors_person ON login_factors(person_id, status);
CREATE TABLE login_challenges (
  id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- H5: social recovery. Guardians are other people who accepted; k of them must approve, and
-- the person's own heads get 24 h to cancel.
CREATE TABLE guardians (
  person_id TEXT NOT NULL REFERENCES people(id),
  guardian_id TEXT NOT NULL REFERENCES people(id),
  status TEXT NOT NULL CHECK (status IN ('invited','active','removed')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (person_id, guardian_id)
);
CREATE TABLE recovery_requests (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  ticket_hash TEXT NOT NULL,
  cancel_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','cancelled','claimed','expired')),
  created_at TEXT NOT NULL,
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE recovery_approvals (
  request_id TEXT NOT NULL,
  guardian_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (request_id, guardian_id)
);

-- H1: buddy mesh. Two people agree to pass critical notices to each other by any means.
CREATE TABLE buddies (
  id TEXT PRIMARY KEY,
  inviter TEXT NOT NULL REFERENCES people(id),
  invitee TEXT REFERENCES people(id),
  code_hash TEXT NOT NULL,
  inviter_label_enc TEXT NOT NULL,         -- how the inviter wants to be named to the buddy
  invitee_label_enc TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','active','ended')),
  created_at TEXT NOT NULL
);
CREATE INDEX buddies_people ON buddies(inviter, invitee, status);

-- H0: failure-domain registry, maintained by people. A domain may fall together with parents.
CREATE TABLE failure_domains (
  id TEXT PRIMARY KEY,                     -- e.g. "ntfy:ntfy.sh"
  parents TEXT NOT NULL DEFAULT '[]',      -- JSON list, e.g. ["cloud:hetzner"]
  notes TEXT,
  updated_at TEXT NOT NULL
);

-- H3: head health, incidents and regrowth.
CREATE TABLE domain_health (
  domain TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('up','degraded','down')),
  ok INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
CREATE TABLE head_incidents (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  cause TEXT NOT NULL,                     -- detected cause tag; a review may correct it
  state TEXT NOT NULL CHECK (state IN ('open','recovered','reviewed')),
  drill_id TEXT,
  started_at TEXT NOT NULL,
  recovered_at TEXT,
  heads_lost INTEGER NOT NULL DEFAULT 0,
  people_affected INTEGER NOT NULL DEFAULT 0,
  review TEXT
);
CREATE UNIQUE INDEX head_incidents_open ON head_incidents(domain) WHERE state='open';
CREATE TABLE regrowth_invites (
  incident_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('none','queued','sent','unreachable')),  -- none = affected, already had enough heads
  suggested TEXT NOT NULL,                 -- JSON list of head kinds
  created_at TEXT NOT NULL,
  PRIMARY KEY (incident_id, person_id)
);
CREATE TABLE club_regrowth (
  id TEXT PRIMARY KEY,
  incident_id TEXT,
  action TEXT NOT NULL,
  domain TEXT,                             -- failure domain of the new path, once known
  state TEXT NOT NULL CHECK (state IN ('proposed','done','declined')),
  automatic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE TABLE canaries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email','ntfy','matrix','mirror','telegram')),
  target_enc TEXT,
  domain TEXT NOT NULL,
  last_run_at TEXT,
  last_ok_at TEXT,
  last_result TEXT,
  fails INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- H1/H6: signed public notices (feeds, mirrors, social announcements, anchors).
CREATE TABLE public_notices (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('notice','incident','relocation','anchor')),
  json TEXT NOT NULL,                      -- Signed<NoticeMeta>
  created_at TEXT NOT NULL
);
CREATE TABLE announce_outbox (
  notice_seq INTEGER NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('mastodon','bluesky','archive')),
  state TEXT NOT NULL CHECK (state IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (notice_seq, target)
);

-- H4: encrypted escrow runs (3-2-1). Only sizes and hashes are recorded here.
CREATE TABLE escrow_runs (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  targets_ok INTEGER NOT NULL,
  targets_failed INTEGER NOT NULL
);

-- H6: manifests of other clubs learned by gossip (verified against the root they carry, and
-- against our pin when we have one).
CREATE TABLE gossip_notices (
  org TEXT PRIMARY KEY,
  manifest_version INTEGER NOT NULL,
  json TEXT NOT NULL,
  via TEXT NOT NULL,
  pinned INTEGER NOT NULL,
  hops INTEGER NOT NULL,
  received_at TEXT NOT NULL
);

-- H7: sealed relocations we hold for a partner (we can't read them alone) and shares received.
CREATE TABLE sealed_held (
  org TEXT NOT NULL,                       -- partner id (node) whose relocation this is
  version INTEGER NOT NULL,
  policy TEXT NOT NULL,                    -- {quorum, silence_days, partners[], heartbeat}
  iv TEXT NOT NULL,
  ct TEXT NOT NULL,
  my_share TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held','confirmed','released','void')),
  last_heartbeat_at TEXT,
  down_checks INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (org, version)
);
CREATE TABLE seal_shares (
  org TEXT NOT NULL,
  version INTEGER NOT NULL,
  from_partner TEXT NOT NULL,
  share TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (org, version, from_partner)
);
