-- Gatherings (plan: journey 8). «Иду» per event, the private "I want to keep in touch" choices, and a
-- short token per attendee, so buttons never carry a Telegram id.
CREATE TABLE rsvps(
  event_key TEXT NOT NULL,              -- source_id:msg_id of the event
  member_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('going','not')),
  token TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY(event_key, member_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX uq_rsvp_token ON rsvps(token);

-- Only a mutual "want to keep in touch" opens contacts (plan: journey 8, guardrails).
CREATE TABLE wants(
  event_key TEXT NOT NULL,
  from_member TEXT NOT NULL,
  to_member TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY(event_key, from_member, to_member)
) WITHOUT ROWID;
