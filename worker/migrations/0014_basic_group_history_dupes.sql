-- One-off cleanup. Basic groups (chat ids above -10^12) number messages per account,
-- so the history import (read with the owner's account) stored a second copy of messages the bot
-- already had live under its own ids. The importer now stops at the group's first /enable; this
-- removes copies stored before that fix: same group, author, second and text, keeping the older
-- row (the live one). Removal works like /forget: body cleared, row kept, search index updated.
UPDATE passages SET body=NULL, removed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
WHERE removed_at IS NULL AND part=0 AND id IN (
  SELECT p.id FROM passages p JOIN sources s ON s.id=p.source_id
  WHERE s.chat_id > -1000000000000 AND p.part=0 AND p.body IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM passages q
      WHERE q.source_id=p.source_id AND q.part=0 AND q.id<p.id AND q.removed_at IS NULL
        AND q.event_at=p.event_at AND q.body=p.body AND q.author_id IS p.author_id
    )
);
-- AI summaries may quote the removed copies.
DELETE FROM ai_cache;
