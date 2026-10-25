-- History import from the owner's browser (Mini App → Desk → History). One row per group.
-- cursor: the oldest Telegram message id imported so far (0 = not started; the browser walks
-- backwards from the newest message, so recent history becomes searchable first).
CREATE TABLE history_jobs(
  source_id TEXT PRIMARY KEY,
  owner_tg INTEGER NOT NULL,               -- who runs it; gets the "continue?" reminder
  cursor INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0,     -- messages stored (skips and duplicates not counted)
  seen INTEGER NOT NULL DEFAULT 0,         -- messages received, for the progress line
  day TEXT,                                -- UTC date of day_count
  day_count INTEGER NOT NULL DEFAULT 0,    -- messages received that day (daily write budget)
  done_at TEXT,
  updated_at TEXT NOT NULL,
  reminded_day TEXT,
  reminders INTEGER NOT NULL DEFAULT 0
);
