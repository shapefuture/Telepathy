-- «Нить» (plan: the main mechanism). One living card per request: one message that is edited in
-- place as the request moves. The card lives in the asker's private chat.
CREATE TABLE threads(
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,              -- the asker's private chat, where the card is shown
  message_id INTEGER,                    -- the card message, edited in place
  question TEXT NOT NULL,
  skills_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK(state IN ('searching','memory','asking','introduced','closed')),
  quotes_json TEXT,                      -- the answer as found, quoted verbatim, with authors and links
  brief TEXT,                            -- optional one-line summary of those quotes
  answer_id TEXT,                        -- feedback handle (answers table), for 👍 / 👎
  need_id TEXT,                          -- the introduction request, once people were asked
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('contact','advice','solved')),
  helper_id TEXT,                        -- the member who helped, when the outcome says so
  thanked_at TEXT,                       -- 🙏 sent to the helper
  followup_at TEXT,                      -- when "Помогло?" becomes due
  followup_sent_at TEXT,
  rev INTEGER NOT NULL DEFAULT 0,        -- card version; each change queues one edit
  answered_at TEXT,                      -- first answer shown (pilot metric)
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_threads_member ON threads(member_id, created_at);
CREATE INDEX idx_threads_need ON threads(need_id) WHERE need_id IS NOT NULL;
CREATE INDEX idx_threads_followup ON threads(followup_at) WHERE followup_at IS NOT NULL AND followup_sent_at IS NULL;

-- Every state change, for the pilot metrics (plan: success is measured by outcomes).
CREATE TABLE thread_events(
  thread_id TEXT NOT NULL,
  state TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX idx_thread_events_state ON thread_events(state, at);

-- Optional first name shown on answer cards ("Анна объясняла это в марте"). Empty unless the
-- member switches it on, so names are not kept by default.
ALTER TABLE members ADD COLUMN display_name TEXT;
