-- The jobs people bring to a club (plan: the census, "Кого здесь советуют", hiring, warm introductions,
-- deals). Forward-only. Personal text and opt-ins are kept only while the person wants them, and
-- forgetting someone clears them (rights.ts).
ALTER TABLE members ADD COLUMN open_work INTEGER NOT NULL DEFAULT 0;  -- open to projects: may be offered hiring requests (needs discoverable)
ALTER TABLE members ADD COLUMN doors TEXT;                             -- "I can introduce you to…": free text, only with discoverable
ALTER TABLE sources ADD COLUMN doors INTEGER NOT NULL DEFAULT 0;      -- the owner's switch: warm introductions in this group
ALTER TABLE threads ADD COLUMN clarify TEXT;                           -- the asker's answer to "budget, deadline, format?" ('' = skipped)
ALTER TABLE needs ADD COLUMN want TEXT;                                -- 'hire' or 'door': how the request routes; NULL routes by skills

-- A deal counts only when both sides confirm it: the asker proposes, the person they were introduced to agrees.
CREATE TABLE deals(
  intro_id TEXT PRIMARY KEY REFERENCES intros(id),
  requester_at TEXT,
  candidate_at TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','agreed','declined')),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
