-- History import from the owner's browser (Mini App → Desk → History).
-- The browser reads the whole chat in seconds and parks it here as raw pages (one row per 100
-- messages, so reading costs almost no daily D1 writes); the cron stores the pages as passages
-- within the daily budget, in the background, and tells the owner when it's finished.
CREATE TABLE history_jobs(
  source_id TEXT PRIMARY KEY,
  owner_tg INTEGER NOT NULL,               -- who ran it; gets the "finished" message
  staged INTEGER NOT NULL DEFAULT 0,       -- messages read by the browser
  imported INTEGER NOT NULL DEFAULT 0,     -- passages stored (skips and duplicates not counted)
  day TEXT,                                -- UTC date of day_count
  day_count INTEGER NOT NULL DEFAULT 0,    -- messages processed that day (daily write budget)
  read_at TEXT,                            -- the browser reached the start of the chat
  done_at TEXT,                            -- everything stored
  updated_at TEXT NOT NULL,
  reminded_day TEXT,
  reminders INTEGER NOT NULL DEFAULT 0
);

-- page: for supergroups, message ids page*100+1 … page*100+100 (read in parallel); for basic
-- groups, the oldest id in a getHistory page. body is NULL once stored (the row stays so a
-- closed tab can resume without re-reading); all rows go when the job is done.
CREATE TABLE history_pages(
  source_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  body TEXT,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(source_id, page)
);
