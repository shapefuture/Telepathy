-- Concierge and the owner's board (ADR-007). Every decision the agent or a rule proposes is a
-- case, judged by a person; the judgements decide what may later run on its own.
--
-- subject: p:<passage> (requests, replay and live), join:<screen>, spam:<flag>, best:<proposal>.
-- Generated text (brief, answer, question) is scrubbed on deletion and after 30 days; numbers and
-- verdicts stay. No member ids are stored on a case.
CREATE TABLE concierge_cases(
  id INTEGER PRIMARY KEY,
  subject TEXT NOT NULL,
  mode TEXT NOT NULL,                     -- replay | live | join | spam | best
  source_id TEXT NOT NULL,
  version TEXT NOT NULL,                  -- prompt or rules version: a change starts a new record
  created_at TEXT NOT NULL,
  model TEXT,
  action TEXT,                            -- answer | ask_people | clarify | escalate | admit | moderate | best_answer; NULL = no usable decision
  error TEXT,                             -- ai_off | ai_failed | invalid_output | replay_failed
  downgraded INTEGER NOT NULL DEFAULT 0,  -- an answer without a verified quote became ask_people
  brief TEXT,
  answer TEXT,
  question TEXT,
  quotes_verified INTEGER NOT NULL DEFAULT 0,
  quotes_failed INTEGER NOT NULL DEFAULT 0,
  evidence INTEGER NOT NULL DEFAULT 0,
  codes TEXT NOT NULL DEFAULT '[]',
  candidates INTEGER NOT NULL DEFAULT 0,
  helper_hit INTEGER,                     -- 1/0: a real replier was among those asked; NULL: nobody replied
  real_replied INTEGER NOT NULL DEFAULT 0,
  real_minutes INTEGER,
  executed INTEGER NOT NULL DEFAULT 0,    -- the step went out (automatically or on approval)
  verdict TEXT,                           -- good | bad | skip
  reviewed_at TEXT,
  UNIQUE(subject, version)
);
CREATE INDEX idx_concierge_review ON concierge_cases(action, version, verdict);
CREATE INDEX idx_concierge_board ON concierge_cases(mode, verdict, executed);

-- Spam guard (group settings). Flags wait for a person unless the moderation gate is earned.
ALTER TABLE sources ADD COLUMN spam_guard INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sources ADD COLUMN screen INTEGER NOT NULL DEFAULT 0;
CREATE TABLE spam_flags(
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  msg_id INTEGER NOT NULL,
  author_tg INTEGER,
  reasons TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','removed','dismissed')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_spam_pending ON spam_flags(status, source_id);

-- Join screening: three questions in private, then the admin decides (or the admit rule does).
-- Answers are kept only while the decision is open; they're cleared when it's made.
CREATE TABLE join_screens(
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  applicant_tg INTEGER NOT NULL,
  user_chat INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT 0,
  answers TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('asking','pending_owner','accepted','declined','expired')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_join_status ON join_screens(status, source_id);

-- Best answers for questions that keep coming back (topic level). Holds ids only: the text is
-- read from the messages, so a deleted message makes the proposal disappear.
CREATE TABLE answer_proposals(
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  code TEXT NOT NULL,
  question_msg INTEGER NOT NULL,
  answer_msg INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined','skipped')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_best_source ON answer_proposals(source_id, code, created_at);

-- Introduction rounds (members opt in with /rounds on): one per member per ISO week.
ALTER TABLE members ADD COLUMN rounds INTEGER NOT NULL DEFAULT 0;
CREATE TABLE intro_rounds(
  week TEXT NOT NULL,
  member_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  intro_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(week, member_id)
);
