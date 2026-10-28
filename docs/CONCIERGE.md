# Concierge and the owner's board

The concierge is an AI agent that takes a member's request to a result: an answer from the club's
memory, people who know, a clarifying question, or the club's team. It runs on Cloudflare Workers AI
only. Design and limits: `architecture/ADR-007-autonomous-concierge.md`.

Nothing it does is silent. Every step it proposes goes on the **board**, a single card an admin
reads once a day. Admins decide with one tap, and every decision is also a review: the reviews are the
evidence that lets an action run on its own.

## The board (`/board`)

Admins (of a connected group, or operators) get one card per day at the digest hour, and only when
something needs a decision. Open it any time with `/board` in a private chat with the bot.

| Section | What it is | ✅ does |
|---|---|---|
| Join requests | Applicants who answered the three screening questions | Accept or decline the join request |
| Suspicious messages | A new member's link, or a link/forward with earn-money wording | Delete the message and restrict its author |
| Unanswered requests | A request unanswered for four hours, with the concierge's proposed step | Send the step (a reply under the request, or a request to people who know) |
| Repeated questions | A topic asked about three times or more, with a reply the club found useful | Mark that reply as the answer and turn hints on for the group |
| Gaps | Operators only: needs several members had and nobody could meet | Create capacity or hide it |

Every decision checks that the admin manages the group the item belongs to. A plain member who
presses a button gets a refusal, and nothing changes.

## Switching things on, and what each one does

Screening and the spam guard are switches on the group's settings card (`/settings`), with the other
group toggles. Everything else is on by default and only ever proposes until earned.

| Feature | Default | What it does |
|---|---|---|
| Join screening | off (`screen`) | Asks applicants three questions in private: who they are, why they're here, what they can help with. The third answer becomes their profile skills (self-claimed, confirmed by their own words). Answers are shown to admins and cleared once decided. |
| Spam guard | on (`spam_guard`) | Flags only; deletes and restricts once `moderate` is earned. Admins' own posts are never flagged. |
| Heated exchanges | always on | Notes to admins when several members use sharp words within 30 minutes. Never acts. |
| Best answers | on | Proposes a reply for a topic asked about three times, once per 90 days. Accepting turns hints on for the group (hints are per group; canonical answers are what they show). |
| Live suggestions | on when the model is on | Proposes a step for requests unanswered for four hours. |
| Introduction rounds | off per member | Members opt in with `/rounds on` (they need `/optin` first). Once a week, Mondays UTC, one introduction on a topic they asked about, to someone who opted in too. Then the normal two-step consent. |

## Jobs people bring (census, hiring, introductions, deals)

What members ask for, and what happens to it. All of it is deterministic: the request's own words
label it, and nothing is sent to a model.

| Piece | Who sees it | What it does |
|---|---|---|
| Census (`/jobs`, and one line on the import card) | The operator, and admins of their groups | Counts requests by kind over six months: answered, how soon, thanked, bumped («ап») and asked again. Shows the share that is about people. Reads at most 4,000 requests and 20,000 replies, once per command. |
| Who recommends it | The asker, from groups they can read | Under a request about a topic, up to three replies that point at a person or a service, quoted word for word, with the date and a link. Never ranked by a model, and never from a group the asker isn't in. |
| Hiring | The asker; people who said `/open on` | «Ищу исполнителя» asks one question first (budget, deadline, format, or skip). Then the usual introduction, offered only to people open to projects, who need `/optin` first. |
| Looking for work | The person looking | A switch on their card, the same as `/open on` / `/open off`. |
| Introductions on request | The asker; people who said `/introduce <line>` | «Нужен выход на…» is matched against the lines people wrote about the doors they can open, in groups whose owner turned it on (`Introductions on request` on the settings card). The line is never shown to anyone. |
| Deals | The asker and the person introduced | «Договорились о работе» closes the request as solved only when the person introduced confirms it too. Until then it's a proposal. |
| Newcomers without contact | The owner (board) | Once a day, a group with at least three people new to the bot who posted in the last 30 days and got no reply and no introduction gets a board item. «Запустить раунд» runs this week's introduction round for the opted-in people there. «Познакомить» sends each newcomer the onboarding card (what they can help with), once per group. The item is hidden for the rest of the week after one press. |

Every introduction still goes through the two-step consent, and contacts open only when both agree.
Introduction rounds, hiring, introductions on request and deals never message anyone who didn't opt in.


## Autonomy

`CONCIERGE_AUTONOMY` sets what may run without a person, per action. Each action has a ceiling in
code, and "auto" needs **50 reviewed cases with at least 90% judged right** for that action (the
evidence is the board's ✅/❌ and the replay's ✅/❌, pooled per action and prompt or rule version).

| Action | Ceiling | Where it's used |
|---|---|---|
| `answer`, `clarify`, `ask_people`, `escalate` | auto | Live suggestions, replay |
| `admit` | auto | Join screening: a complete screening is accepted by rule |
| `moderate` | auto | Spam guard: delete and restrict |
| `best_answer` | suggest | Repeated questions. The club's canonical answer stays the owner's call |
| `introduce`, `ask_partners`, `paid_provider` | suggest | Introductions and partner or paid steps (not built yet) |

Example: `CONCIERGE_AUTONOMY=clarify:auto,admit:auto`. Missing = off. Until an action has been
earned it behaves as `suggest`, whatever the setting says.

## Run the replay first

1. Deploy with migration `0023_concierge.sql` (`npm run db:migrate:remote`). The `AI` binding is
   already in `wrangler.jsonc`.
2. In a private chat with the bot, as an operator: `/concierge`, then **▶️ Replay 20**. Two past
   requests a minute, and it writes when done. Only groups you can read are used.
3. **📝 Review** shows each replayed decision next to what really happened. Judge them; the report
   shows how many requests really went unanswered, and how often its routing found the person who
   really replied.

## What is sent, and what is kept

- **To Workers AI:** the request and up to three short earlier conversations from the same group,
  redacted (no emails, phones, @usernames, links, tokens), with no names, ids or chat titles.
- **Kept:** one row per decision (`concierge_cases`) with the action, counts and the judgement. Generated
  text is erased when any message or member is deleted, at retention purges, and after 30 days. No member
  ids are stored on a case.
- **Join answers** are kept only while the decision is open, and deleted on `/forget_me`.
- **Spam flags** keep the reasons and the message's link, not its text.
- **Rules that are not AI** (screening, spam, best answers) are reviewed the same way, so their
  autonomy is earned the same way.
- **Jobs:** `/introduce` keeps the line about the doors someone can open (and `/introduce off` clears it);
  `/open` keeps the open-to-projects switch. Both are cleared by `/forget_me`. A hiring or introduction
  request keeps the answer to its clarifying question on its card, erased on `/forget_me`.
- **Deals** keep only the two timestamps and the status (proposed, agreed, declined).

Tell members in your group rules that requests are read to route them, and that a screening asks
three questions.

## Settings

| Var / setting | Meaning |
|---|---|
| `CONCIERGE_MODEL` | Workers AI model. Empty = the summaries' default. `off` disables the AI actions (replay, live suggestions). |
| `CONCIERGE_AUTONOMY` | Per-action levels, as above. |
| Group settings card | `Screen join requests`, `Catch spam`, `Introductions on request` (on each group). |
| Census window | Fixed in code: 180 days for `/jobs`, 30 days for newcomers, 14 days for bumps, 48 hours for thanks. |
| Census window | Fixed in code: 180 days for `/jobs`, 30 days for newcomers, 14 days for bumps, 48 hours for thanks. |

Telegram rights the bot needs: approve and decline join requests (for screening), delete messages and
restrict members (for the spam guard). Without them the board says "Didn't go through".

## Reading the result

- Few unanswered requests → the club already copes. The concierge should save the team's time, so
  measure that instead.
- Many unanswered and a checked answer available → the case for live suggestions.
- Routing rarely finds the real helper → the people side is the weak point. Ask helpers to state
  their topics (`/optin`) before trusting it to ask anyone.
- Many ❌ on one action → keep that action at `suggest` and look at the cases. Change the prompt (it
  bumps `PROMPT_VERSION`) or the model, and replay again.
- Spam: if admins keep dismissing flags, look at which reasons they dismiss most. The reasons are a
  short list, so that is a quick read.

## Known limits

- Heated-exchange detection is a short word list. It notes, and never acts.
- The spam guard catches new members with links and earn-money wording. It doesn't see
  lookalike names or account age, which Telegram doesn't expose to bots.
- Best answers are topic-level, from words in the request. Two different questions on one topic
  can share a proposal.
- Hints are per group, not per topic. Canonical marking is what makes a topic's answer surface.
- Automatic decisions are logged but not re-reviewed after they run. A wrong automatic removal is
  found by the member or an admin, not by the gate.
