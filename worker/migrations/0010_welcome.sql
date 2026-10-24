-- Welcome for people who join an enabled group (on by default; /welcome off per group).
ALTER TABLE sources ADD COLUMN welcome INTEGER NOT NULL DEFAULT 1;
-- One welcome per person per group, ever (leaving and rejoining doesn't repeat it).
CREATE TABLE welcomed (
  source_id TEXT NOT NULL,
  tg_id INTEGER NOT NULL,
  via TEXT NOT NULL,                 -- dm | join_request | group
  at TEXT NOT NULL,
  PRIMARY KEY (source_id, tg_id)
);
-- Group fallback messages delete themselves after a short while (cron).
CREATE TABLE pending_deletes (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  delete_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
