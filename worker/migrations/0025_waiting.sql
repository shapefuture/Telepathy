-- Unmatched requests wait for someone who can help, instead of closing (plan: «Нить»).
-- Requests closed as no-match that have not expired yet start waiting again.
UPDATE needs SET status = 'waiting' WHERE status = 'no_match' AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now');
