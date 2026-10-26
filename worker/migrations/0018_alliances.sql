-- Союз (plan: journey 5). Two clubs on this bot agree to exchange requests. The level is the
-- smaller of what each side offered: requests (owners see them), experts (experts see them, as roles),
-- or full (the expert directory is open to the asker as well).
CREATE TABLE alliances(
  id TEXT PRIMARY KEY,
  inviter_source_id TEXT NOT NULL,
  partner_source_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('requests','experts','full')),
  status TEXT NOT NULL CHECK(status IN ('active','paused','ended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(inviter_source_id, partner_source_id)
);

-- One-use invitations: a link that a club owner sends to another club owner.
CREATE TABLE alliance_invites(
  code TEXT PRIMARY KEY,
  inviter_source_id TEXT NOT NULL,
  inviter_member_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('requests','experts','full')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Мост (plan: journey 6). Only the request text crosses. The asker's identity and contact stay
-- with them until the helper and the asker both agree to connect.
CREATE TABLE bridges(
  id TEXT PRIMARY KEY,
  alliance_id TEXT NOT NULL,
  from_source_id TEXT NOT NULL,
  to_source_id TEXT NOT NULL,
  asker_id TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','helper_yes','connected','closed','expired')),
  helper_id TEXT,
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('helpful')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_bridges_status ON bridges(status, to_source_id);
CREATE INDEX idx_bridges_asker ON bridges(asker_id, created_at);

-- Which club a group question came from, and the bridge a card is following.
ALTER TABLE threads ADD COLUMN source_id TEXT;
ALTER TABLE threads ADD COLUMN bridge_id TEXT;
