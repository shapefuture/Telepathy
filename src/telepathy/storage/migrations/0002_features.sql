-- 0002_features: experts, introductions, documents, digests, data rights.

-- Member preferences (all privacy-preserving defaults).
ALTER TABLE members ADD COLUMN available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1));
ALTER TABLE members ADD COLUMN reminders_opt_in INTEGER NOT NULL DEFAULT 1
  CHECK(reminders_opt_in IN (0,1));
-- C13: member withdrew collection consent; their messages are not stored.
ALTER TABLE members ADD COLUMN collection_opt_out INTEGER NOT NULL DEFAULT 0
  CHECK(collection_opt_out IN (0,1));

-- Local rule-based intent (P04-09); never leaves the host.
ALTER TABLE messages ADD COLUMN intent TEXT;
ALTER TABLE messages ADD COLUMN intent_confidence REAL;
CREATE INDEX idx_messages_source_time ON messages(source_id, event_at);
CREATE INDEX idx_messages_author ON messages(author_member_id);

-- Where in a document an excerpt sits: "p. 3", "slide 4", "12:34".
ALTER TABLE excerpts ADD COLUMN locator TEXT;
CREATE INDEX idx_excerpts_document ON excerpts(document_id);

ALTER TABLE documents ADD COLUMN message_id TEXT REFERENCES messages(id);
ALTER TABLE documents ADD COLUMN title TEXT;
ALTER TABLE documents ADD COLUMN status TEXT NOT NULL DEFAULT 'parsed'
  CHECK(status IN ('parsed','needs_ocr','unsupported','failed','removed'));
ALTER TABLE documents ADD COLUMN excerpt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE needs ADD COLUMN skill_codes_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX idx_needs_member ON needs(member_id, created_at);

ALTER TABLE introductions ADD COLUMN reminder_sent_at TEXT;
ALTER TABLE introductions ADD COLUMN outcome TEXT
  CHECK(outcome IS NULL OR outcome IN ('helpful','no_response','not_helpful'));
ALTER TABLE introductions ADD COLUMN score_json TEXT;
CREATE INDEX idx_intro_candidate ON introductions(candidate_id, status, created_at);

CREATE UNIQUE INDEX uq_skill_claim ON skill_claims(member_id, skill_code);

-- Audited community settings (timezone, digest time, ...).
CREATE TABLE community_settings(
  community_id TEXT NOT NULL REFERENCES communities(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(community_id, key)
);
