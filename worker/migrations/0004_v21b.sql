-- v2.1 remaining features (P13-03, 06, 07, 09, 10).
ALTER TABLE members ADD COLUMN routing INTEGER NOT NULL DEFAULT 1;      -- P13-03 expert can opt out of pings
ALTER TABLE members ADD COLUMN catchup_at TEXT;                         -- P13-06 last /catchup
ALTER TABLE sources ADD COLUMN routing INTEGER NOT NULL DEFAULT 0;      -- P13-03 owner sign-off per group
ALTER TABLE passages ADD COLUMN canonical INTEGER NOT NULL DEFAULT 0;   -- P13-07
ALTER TABLE passages ADD COLUMN superseded_by INTEGER;                  -- P13-07
CREATE TABLE skill_dismissed(member_id TEXT NOT NULL, code TEXT NOT NULL, PRIMARY KEY(member_id, code)) WITHOUT ROWID; -- P13-09
CREATE TABLE events(                                                    -- P13-10
  source_id TEXT NOT NULL, msg_id INTEGER NOT NULL, title TEXT NOT NULL, starts_at TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, PRIMARY KEY(source_id, msg_id)
) WITHOUT ROWID;
CREATE INDEX idx_events_start ON events(starts_at);
