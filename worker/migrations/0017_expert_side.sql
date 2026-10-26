-- Quiet hours for experts (plan: journey 4): UTC hours, NULL = none. Converted from the club's
-- timezone when set, so the matcher can compare with the current UTC hour.
ALTER TABLE members ADD COLUMN quiet_from INTEGER;
ALTER TABLE members ADD COLUMN quiet_to INTEGER;

-- One question at a time for the member: the next private message is their thank-you words.
CREATE TABLE pending_inputs(
  member_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
