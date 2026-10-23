-- Telepathy v2 (Cloudflare D1). Designed for the free tier:
--   * message text is stored ONCE (passages.body); the FTS index is external-content
--   * citation links are computed at query time, not stored
--   * no raw-event copies; idempotency comes from UNIQUE(source_id, msg_id, part)
-- All timestamps are ISO-8601 UTC strings.

CREATE TABLE settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE members(
  id TEXT PRIMARY KEY,                      -- random pseudonymous id used everywhere else
  tg_id INTEGER NOT NULL UNIQUE,            -- the only place the Telegram id lives
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','moderator','admin','owner')),
  discoverable INTEGER NOT NULL DEFAULT 0,  -- expert discovery consent (C04)
  available INTEGER NOT NULL DEFAULT 1,
  reminders INTEGER NOT NULL DEFAULT 1,
  digest INTEGER NOT NULL DEFAULT 0,        -- daily digest opt-in (K14)
  collection_opt_out INTEGER NOT NULL DEFAULT 0,  -- C13: their messages are not stored
  created_at TEXT NOT NULL,
  removed_at TEXT
);

CREATE TABLE sources(
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL UNIQUE,
  title TEXT,
  username TEXT,                            -- public groups: t.me/<username>/<id> links
  visibility TEXT NOT NULL
    CHECK(visibility IN ('PUBLIC_APPROVED','MEMBER_CONSENTED','INTERNAL_RESTRICTED')),
  enabled INTEGER NOT NULL DEFAULT 1,
  enabled_by TEXT,
  enabled_at TEXT NOT NULL,
  retention_days INTEGER NOT NULL DEFAULT 0 -- 0 = keep full history (K15)
);

CREATE TABLE source_access(
  source_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(source_id, member_id)
) WITHOUT ROWID;

-- One row per searchable passage: part 0 = the message text/caption,
-- part 1..n = chunks of an attached text document.
CREATE TABLE passages(
  id INTEGER PRIMARY KEY,                   -- FTS content rowid
  source_id TEXT NOT NULL,
  msg_id INTEGER NOT NULL,
  part INTEGER NOT NULL DEFAULT 0,
  author_id TEXT,
  body TEXT,                                -- NULL once removed
  label TEXT,                               -- e.g. "notes.vtt · 02:00"
  event_at TEXT NOT NULL,
  edit_version INTEGER NOT NULL DEFAULT 0,  -- Telegram edit_date; 0 = original
  topic_id INTEGER,
  reply_to INTEGER,
  intent TEXT,
  intent_conf REAL,
  removed_at TEXT,
  UNIQUE(source_id, msg_id, part)
);
CREATE INDEX idx_passages_author ON passages(author_id) WHERE author_id IS NOT NULL;
CREATE INDEX idx_passages_time ON passages(source_id, event_at);

CREATE VIRTUAL TABLE passages_fts USING fts5(
  body, content='passages', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
-- Vocabulary view used for typo correction.
CREATE VIRTUAL TABLE passages_vocab USING fts5vocab(passages_fts, 'row');

CREATE TRIGGER passages_ai AFTER INSERT ON passages
WHEN new.body IS NOT NULL AND new.removed_at IS NULL BEGIN
  INSERT INTO passages_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER passages_au AFTER UPDATE OF body, removed_at ON passages BEGIN
  INSERT INTO passages_fts(passages_fts, rowid, body)
    SELECT 'delete', old.id, old.body WHERE old.body IS NOT NULL AND old.removed_at IS NULL;
  INSERT INTO passages_fts(rowid, body)
    SELECT new.id, new.body WHERE new.body IS NOT NULL AND new.removed_at IS NULL;
END;
CREATE TRIGGER passages_ad AFTER DELETE ON passages
WHEN old.body IS NOT NULL AND old.removed_at IS NULL BEGIN
  INSERT INTO passages_fts(passages_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;

CREATE TABLE skills(
  member_id TEXT NOT NULL,
  code TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('suggested','confirmed')),
  kind TEXT NOT NULL DEFAULT 'self_claim',
  PRIMARY KEY(member_id, code)
) WITHOUT ROWID;

CREATE TABLE needs(
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  text TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  status TEXT NOT NULL,                     -- open | matching | no_match | cancelled | closed | expired
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_needs_member ON needs(member_id, created_at);

CREATE TABLE intros(
  id TEXT PRIMARY KEY,
  need_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('invited','accepted','mutually_confirmed',
    'completed','declined','expired','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  invite_expires_at TEXT NOT NULL,
  reminder_sent_at TEXT,
  outcome TEXT,
  score_json TEXT,
  UNIQUE(need_id, candidate_id)
);
-- P09-02: one live invitation per request.
CREATE UNIQUE INDEX uq_intro_live ON intros(need_id) WHERE status IN ('invited','accepted');
CREATE INDEX idx_intros_candidate ON intros(candidate_id, status);

-- Outgoing Telegram messages (C09). 'dispatching' left behind by a crash becomes 'uncertain'.
CREATE TABLE effects(
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  chat_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','dispatching','sent','uncertain','reconciled','failed','skipped')),
  ref TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_effects_state ON effects(state, created_at);

CREATE TABLE audit(
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  subject TEXT,
  detail TEXT
);
