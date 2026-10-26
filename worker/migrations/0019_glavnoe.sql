-- «Главное» (plan: journey 7): a line of the daily card that the person marked as done. Done lines
-- don't come back on later days.
CREATE TABLE glavnoe_done(
  member_id TEXT NOT NULL,
  passage_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY(member_id, passage_id)
) WITHOUT ROWID;
