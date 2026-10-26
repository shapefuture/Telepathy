-- Multi-community: each group's own Telegram admins manage it (connect, settings, history), so
-- the app needs "is this person an admin of that group" often. Telegram is the truth; this
-- caches its answer for a few minutes and is cleared when a chat_member update changes a role.
CREATE TABLE chat_admins(
  chat_id INTEGER NOT NULL,
  tg_id INTEGER NOT NULL,
  is_admin INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY(chat_id, tg_id)
);
