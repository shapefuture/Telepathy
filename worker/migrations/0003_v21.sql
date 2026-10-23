-- v2.1 member features (P13-01, P13-02, P13-04, P13-05).

-- P13-04: interface language. lang_explicit=1 once the member chose with /language.
ALTER TABLE members ADD COLUMN lang TEXT CHECK(lang IS NULL OR lang IN ('en','ru'));
ALTER TABLE members ADD COLUMN lang_explicit INTEGER NOT NULL DEFAULT 0;

-- P13-02: "already answered" hints, per group, off until an owner turns them on.
ALTER TABLE sources ADD COLUMN hints INTEGER NOT NULL DEFAULT 0;

-- P13-05: answer feedback. Votes are private; only per-passage totals affect ranking.
CREATE TABLE answers(
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  passage_ids TEXT NOT NULL,                -- JSON array, in quote order
  created_at TEXT NOT NULL
);
CREATE INDEX idx_answers_member ON answers(member_id);

CREATE TABLE answer_votes(
  answer_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  vote TEXT NOT NULL,                       -- 'up' | 'down' | 'bad:<quote index>'
  created_at TEXT NOT NULL,
  PRIMARY KEY(answer_id, member_id, vote)
) WITHOUT ROWID;

CREATE TABLE passage_votes(
  passage_id INTEGER PRIMARY KEY,
  up INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0,
  bad INTEGER NOT NULL DEFAULT 0
);
