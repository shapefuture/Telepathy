-- 0001_init: core schema (P02-01..P02-08).
-- Derived from architecture/schema.sql with these changes:
--   * members.role for access decisions (admin/moderator gates)
--   * source_access: per-member, per-source read grants (deny by default)
--   * messages.edit_version for out-of-order edit handling (P03-03)
--   * FTS rows keyed by excerpts.rowid so deletes are O(log n)
--   * effect_intents gains 'dispatching' + unique idempotency_key (P02-08)
--   * audit_log and sync_state tables
-- All timestamps are ISO-8601 UTC strings.

CREATE TABLE communities(
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
  created_at TEXT NOT NULL
);

CREATE TABLE members(
  id TEXT PRIMARY KEY,                       -- random pseudonymous ID used everywhere else
  community_id TEXT NOT NULL REFERENCES communities(id),
  telegram_user_id TEXT,                     -- only place the platform ID lives
  role TEXT NOT NULL DEFAULT 'member'
    CHECK(role IN ('member','moderator','admin','owner')),
  discovery_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(discovery_opt_in IN (0,1)),
  profile_visibility TEXT NOT NULL DEFAULT 'private',
  created_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE(community_id, telegram_user_id)
);
CREATE INDEX idx_members_consent ON members(community_id, discovery_opt_in);

CREATE TABLE sources(
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  platform TEXT NOT NULL,
  external_ref TEXT NOT NULL,                -- Telegram chat_id as text
  title TEXT,
  public_username TEXT,                      -- for t.me/<username>/<id> links
  visibility TEXT NOT NULL
    CHECK(visibility IN ('PUBLIC_APPROVED','MEMBER_CONSENTED','INTERNAL_RESTRICTED','PRIVATE_UNKNOWN')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  enabled_by TEXT REFERENCES members(id),
  enabled_at TEXT,
  retention_days INTEGER NOT NULL DEFAULT 90,
  policy_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(community_id, platform, external_ref)
);

CREATE TABLE source_access(
  source_id TEXT NOT NULL REFERENCES sources(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  granted_at TEXT NOT NULL,
  grant_reason TEXT NOT NULL,                -- 'observed_post' | 'chat_member' | 'admin'
  revoked_at TEXT,
  PRIMARY KEY(source_id, member_id)
);

CREATE TABLE raw_events(
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  dedup_key TEXT NOT NULL UNIQUE,
  observed_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,                    -- minimized: no names, usernames or phone numbers
  processed_at TEXT
);

CREATE TABLE messages(
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_message_id TEXT NOT NULL,
  author_member_id TEXT REFERENCES members(id),
  body TEXT,
  media_kind TEXT,
  media_file_id TEXT,
  event_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  edited_at TEXT,
  edit_version INTEGER NOT NULL DEFAULT 0,   -- Telegram edit_date (0 = original)
  topic_id TEXT,
  reply_to_id TEXT,                          -- external id of parent; may be orphaned
  removed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(source_id, external_message_id)
);

CREATE TABLE documents(
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  format TEXT NOT NULL,
  parser_version TEXT NOT NULL DEFAULT '0',
  created_at TEXT NOT NULL,
  removed_at TEXT
);

CREATE TABLE excerpts(
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  message_id TEXT REFERENCES messages(id),
  document_id TEXT REFERENCES documents(id),
  body TEXT NOT NULL,
  citation_uri TEXT,
  event_at TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,                             -- non-NULL = stale/revoked, never cited (C06)
  supersedes_id TEXT REFERENCES excerpts(id),
  content_sha256 TEXT NOT NULL,
  index_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_excerpts_source ON excerpts(source_id, valid_to);
CREATE INDEX idx_excerpts_message ON excerpts(message_id);

-- rowid = excerpts.rowid. Body is NFC-normalized and casefolded.
CREATE VIRTUAL TABLE excerpts_fts USING fts5(body, tokenize='unicode61 remove_diacritics 2');

CREATE TABLE embeddings(
  id TEXT PRIMARY KEY,
  excerpt_id TEXT NOT NULL REFERENCES excerpts(id),
  model_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  input_type TEXT NOT NULL CHECK(input_type IN ('passage','query')),
  policy_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  vector_blob BLOB NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(excerpt_id, model_id, dimensions, input_type, policy_version)
);

CREATE TABLE consent(
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  purpose TEXT NOT NULL,
  granted INTEGER NOT NULL CHECK(granted IN (0,1)),
  granted_at TEXT,
  revoked_at TEXT,
  version INTEGER NOT NULL,
  UNIQUE(member_id, purpose, version)
);

CREATE TABLE skill_claims(
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  skill_code TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('suggested','confirmed','hidden','withdrawn')),
  evidence_kind TEXT NOT NULL DEFAULT 'self_claim'
    CHECK(evidence_kind IN ('self_claim','validated_role','teaching_contribution',
                            'confirmed_help_outcome','weak_conversation_signal')),
  evidence_excerpt_id TEXT REFERENCES excerpts(id),
  confirmed_at TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  valid_to TEXT
);

CREATE TABLE knowledge_claims(
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  statement TEXT NOT NULL,
  review_state TEXT NOT NULL DEFAULT 'proposed',
  valid_from TEXT,
  valid_to TEXT,
  supersedes_id TEXT REFERENCES knowledge_claims(id)
);

CREATE TABLE claim_evidence(
  claim_id TEXT NOT NULL REFERENCES knowledge_claims(id),
  excerpt_id TEXT NOT NULL REFERENCES excerpts(id),
  PRIMARY KEY(claim_id, excerpt_id)
);

CREATE TABLE needs(
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE offers(
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  skill_code TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE introductions(
  id TEXT PRIMARY KEY,
  need_id TEXT NOT NULL REFERENCES needs(id),
  requester_id TEXT NOT NULL REFERENCES members(id),
  candidate_id TEXT REFERENCES members(id),
  status TEXT NOT NULL CHECK(status IN ('requested','candidate_selected','invited','accepted',
    'mutually_confirmed','scheduled','completed','declined','expired','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  invite_expires_at TEXT,
  UNIQUE(need_id, candidate_id)
);
-- P09-02: at most one live invitation per request.
CREATE UNIQUE INDEX uq_intro_one_live_invite ON introductions(need_id)
  WHERE status IN ('candidate_selected','invited','accepted');

CREATE TABLE jobs(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','leased','completed','failed','manual')),
  run_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_due ON jobs(state, run_at);

CREATE TABLE effect_intents(
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK(state IN ('pending','dispatching','sent','uncertain','reconciled','failed')),
  provider_response_ref TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_effects_state ON effect_intents(state);

CREATE TABLE audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_member_id TEXT,
  action TEXT NOT NULL,
  subject TEXT,
  detail_json TEXT
);

CREATE TABLE sync_state(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE release_journal(
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL,
  action TEXT NOT NULL,
  evidence_digest TEXT,
  authorized_by TEXT,
  at TEXT NOT NULL
);
