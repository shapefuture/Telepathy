# Job research kit (P14-11, plan Track 1 and §M.2)

The code can't pass gates G1–G3; people can. This kit is the shortest path.

## 1. Collect real cases (1–2 weeks)

- Turn the desk on for members: announce `/help <what you need>` in your groups.
- For each request, tag what kind of case it is: `/desk tag #<id> <type>`:
  `knowledge_answer` · `qualified_expert_review` · `warm_intro` · `reserved_office_hour` ·
  `small_panel` · `commercial_project`.
- `/desk report` shows stages, outcomes and case types. `/desk gaps` shows needs that 5 or more
  members had and nobody served.

## 2. Interview (30 minutes each; 5 operators, 5 members, 2 would-be providers)

Ask about the **last real case**, not opinions:

1. What happened that made you (or the member) look for help? When?
2. What would a good outcome have looked like? How would you know?
3. What did you try first? Who did you ask? How many messages, how much time?
4. What happened in the end? What did it cost when it went wrong?
5. Why that workaround and not another?
6. What would worry you about sending this request to a partner community?
7. Who decides to spend on member services? What budget exists today?

Then offer the concrete thing: "We take one request you couldn't solve, ask one partner
community with the member's consent, and report back. Would you try it on <specific case> this
month?" Record the answer as a **commitment** (yes, with a case and a date) or not. Praise isn't
a commitment.

## 3. Find one partner

- Choose a community whose members can solve your top gap (`/desk gaps`, interview step 4).
- Agree `PARTNER_CONSTITUTION.md`, sign it, exchange keys (`OPERATOR_GUIDE.md`).
- They publish at least one real offer with real slots (`/offer add`).

## 4. Run one sanctioned exchange

One member, one request, explicit preview and consent, one partner. Afterwards:
`/desk report` should show `delivered` and an `evaluated` receipt. Write a short note in issue
#167: what worked, what was slow, what the member said.

## Gate checklist

| Gate | Evidence |
|---|---|
| G0 privacy | no incident during the pilot; test suite green |
| G1 buyer/job | ≥ 3 operators named a recurring, costly case and committed to try |
| G2 supply | ≥ 1 partner signed and published real slots |
| G3 delivery | ≥ 3 requests reached delivered or a clearly explained no-provider |
