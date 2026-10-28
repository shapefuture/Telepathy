-- «Звать меня на помощь» off now also turns off hiring offers (/open), the introductions line (/introduce,
-- deleted) and introduction rounds (/rounds). Members who turned it off before that rule keep the old values,
-- and /optin would bring them back. Clear them once, and record each one in the audit log.
INSERT INTO audit (at, actor, action, subject, detail)
  SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system', 'consent.cleared', id,
         json_object('open_work', open_work, 'doors', doors IS NOT NULL, 'rounds', rounds)
  FROM members
  WHERE discoverable = 0 AND (open_work = 1 OR doors IS NOT NULL OR rounds = 1);
UPDATE members SET open_work = 0, doors = NULL, rounds = 0
  WHERE discoverable = 0 AND (open_work = 1 OR doors IS NOT NULL OR rounds = 1);
