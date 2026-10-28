-- Autonomous concierge, first slice (ADR-007): replaying past requests to measure what the agent
-- would have done, and the owner's verdicts on it. Nothing here messages anyone.
--
-- One row per past request and prompt version. The generated text (brief, answer, question) is
-- derived from members' messages, so it is scrubbed whenever a message or a member is deleted
-- and after 30 days; the numbers and verdicts stay.
CREATE TABLE concierge_cases(
  id INTEGER PRIMARY KEY,
  passage_id INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  model TEXT,
  action TEXT,                 -- answer | ask_people | clarify | escalate; NULL = no usable decision
  error TEXT,                  -- ai_off | ai_failed | invalid_output | replay_failed
  downgraded INTEGER NOT NULL DEFAULT 0, -- an answer without a verified quote became ask_people
  brief TEXT,
  answer TEXT,
  question TEXT,
  quotes_verified INTEGER NOT NULL DEFAULT 0,
  quotes_failed INTEGER NOT NULL DEFAULT 0,
  evidence INTEGER NOT NULL DEFAULT 0,      -- earlier messages found in memory
  codes TEXT NOT NULL DEFAULT '[]',         -- topic codes used for routing
  candidates INTEGER NOT NULL DEFAULT 0,    -- people the routing would have asked (no ids kept)
  helper_hit INTEGER,                       -- 1/0: someone who really replied was among them; NULL: nobody replied
  real_replied INTEGER NOT NULL DEFAULT 0,
  real_minutes INTEGER,                     -- minutes to the first real reply
  verdict TEXT,                             -- good | bad | skip (the owner's review)
  reviewed_at TEXT,
  UNIQUE(passage_id, version)
);
CREATE INDEX idx_concierge_review ON concierge_cases(version, verdict);
