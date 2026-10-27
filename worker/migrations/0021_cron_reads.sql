-- The cron runs every minute, and D1's free plan allows 5M row reads a day (about 3,500 a
-- minute). These indexes let the per-minute checks read only the rows they need.

-- Unanswered questions (routing) and the weekly Пульс: questions in a time window, and replies to them.
CREATE INDEX IF NOT EXISTS idx_passages_help ON passages(event_at) WHERE intent = 'help_request' AND part = 0 AND removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_passages_reply ON passages(source_id, reply_to) WHERE reply_to IS NOT NULL;

-- "Pings this expert got today".
CREATE INDEX IF NOT EXISTS idx_effects_chat ON effects(chat_id, created_at);

-- Expiry sweeps.
CREATE INDEX IF NOT EXISTS idx_needs_status ON needs(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_intros_status ON intros(status, invite_expires_at);
CREATE INDEX IF NOT EXISTS idx_missions_expiry ON missions(expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_deletes_due ON pending_deletes(delete_at);

-- History import: pages still waiting to be stored, and the first time a group was enabled.
CREATE INDEX IF NOT EXISTS idx_history_pages_waiting ON history_pages(source_id, page) WHERE body IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit(action, subject);
