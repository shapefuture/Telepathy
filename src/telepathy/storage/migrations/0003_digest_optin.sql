-- 0003_digest_optin: members choose to receive the daily digest (P10-04, K14).
-- Default off: nobody gets digests without asking.
ALTER TABLE members ADD COLUMN digest_opt_in INTEGER NOT NULL DEFAULT 0
  CHECK(digest_opt_in IN (0,1));
CREATE INDEX idx_members_digest ON members(community_id, digest_opt_in);
