-- Strong login = two different methods in the SAME browser within 15 minutes. A new login made
-- while this browser still holds a session links to it; other people's or other devices' sessions
-- never count.
ALTER TABLE sessions ADD COLUMN parent_hash TEXT;
