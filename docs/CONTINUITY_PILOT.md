# Continuity pilot and risk model (CONT-0)

The code can't prove there is a job worth paying for. This is the shortest honest test.

## Risk model (what can fail, and what we can and can't do)

| Failure | Covered by | Not covered |
|---|---|---|
| Group deleted, banned or hijacked | portal, verified email, signed relocation, alerts | people who never enrolled |
| Bot removed | portal and email keep working | Telegram-only notices |
| Admin account lost | owner portal login (email + recovery code) | recovery codes nobody stored |
| Domain lost | partners' relay, pinned root, backup addresses | members who never pinned or saw the root |
| Telepathy or Cloudflare gone | signed export + Python restore + new install | seamless sending without a prepared second provider |
| Online key stolen | can't move primary; rotate with `root-next` | backup-address spam until rotation |
| Root keys lost | threshold (2 of 3) tolerates one loss | losing two: start a new identity, re-pin by hand |
| Restored old backup | ops log + import of newest export | rows restored but never reconciled |

## Interviews (5 operators): ask about real episodes

1. Have you lost a group, channel, admin access or a mailing list? When, and what did it cost?
2. How did members find you again? How many didn't?
3. What do you use today besides Telegram (email list, site, CRM)? How many members are on it?
4. Who pays for member services, and what would losing a quarter of members cost you?

Then offer the Continuity Check: *"We'll measure how many of your members can reach you without
Telegram, and run one drill."* Record a **commitment** (a date, a group), not praise.

## Gate (from the plan, §9 CONT-0)

- At least one operator confirms a real loss from a single platform, **and**
- agrees in writing to the honest limits above, **and**
- runs a drill: `/drill start telegram_down` → `/drill end`. Write the result (RDS) and what
  people said in issue CONT-0.

## Decisive comparison (plan §14)

Compare against a plain independent site + email/RSS + CSV export for similar clubs. If Telepathy
doesn't win on enrolment, verified reach, speed of a verified relocation, operator effort or cost
per recovered member, keep only the simple parts.
