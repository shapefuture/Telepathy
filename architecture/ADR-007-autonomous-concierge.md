# ADR-007: Autonomous concierge on Workers AI — a permission envelope, earned autonomy

**Status:** accepted for the prototype (2026-10-28). Built: history replay and review; the owner's board; live suggestions; join screening; spam guard; best answers; introduction rounds; the census of jobs; recommendations; hiring; introductions on request; deals; newcomers without contact.
**Context:** `docs/CONCIERGE.md`, `docs/AI.md`, ADR-002 (disclosure and consent).

## The job

Members have tasks and requests. Today they ask in a chat, the request scrolls away, and whether
it gets resolved depends on whether the right person happened to see it. The owner either becomes
an unpaid router or hires one. The product's job: **every member request is resolved, or ends with
a clear next step, without the member needing to know whom to ask and with the owner doing nothing
but setting rules.** Memory, club members, the club's team, partner clubs and paid providers are
the means, tried in that order. The concierge is the one face over them.

## Decisions

- **The concierge is an AI agent, and the model is Cloudflare Workers AI only** (binding `AI`,
  var `CONCIERGE_MODEL`, default the summaries' model; `off` disables it). The text stays with the
  host that already stores the community's messages. Beam/Ollama Cloud is never used for the
  concierge. Everything sent is redacted (`ai/redact.ts`), limited to what the member could read
  (ACL), and cut off at the request's time when replaying history.
- **The model proposes; code decides.** Its output must parse into one of four next steps
  (`answer`, `ask_people`, `clarify`, `escalate`); anything else is recorded as no decision. An
  answer stands only on quotes found word for word in the sources (`ai/verify.ts`); otherwise it
  becomes `ask_people`. Routing (whom to ask) is deterministic code, not the model. The model has
  no tools. Request and message text is data, never instructions.
- **A permission envelope in code** (`concierge/policy.ts`). Each action has a ceiling:
  `clarify`, `answer`, `ask_people`, `follow_up`, `escalate` can reach `auto`; `introduce`,
  `ask_partners`, `paid_provider` never go above `suggest` (a person approves: both people for an
  introduction, the member for anything leaving the club or costing money). The owner configures a
  level per action (`CONCIERGE_AUTONOMY`, default all `off`); the effective level is the lower of
  the configuration and the ceiling.
- **Autonomy is earned by evidence.** `auto` is granted only once at least 50 of the agent's past
  decisions of that kind were reviewed by the owner and at least 90% judged right. Until then a
  configured `auto` acts as `suggest`. The thresholds are constants, not settings.
- **Asking people autonomously is legitimate only inside consent given in advance:** a helper's
  topics, weekly cap (`EXPERT_WEEKLY_CAP`), quiet hours and availability, as `eligibleCandidates`
  already enforces. The agent makes asking cheap, so the helper's cap is the hard limit that keeps
  the community from being spammed.
- **First, replay history; message nobody.** Before any live step, the agent runs over the group's
  past requests (`concierge/replay.ts`) using only what existed before each one (`search` and
  `conversation` take a `before` cutoff). Each case records the decision, whether someone really
  replied and how soon, and whether a real replier was among the people routing would ask (a
  yes/no; no member ids are stored on a case). The operator reviews cases on one Telegram card
  (`/concierge`), and those verdicts are the evidence the autonomy gate reads.
- **Deletion wins.** Generated text on a case (brief, answer, question) can quote anyone, so it is
  scrubbed whenever a message or member is deleted or a retention purge runs, exactly like
  `ai_cache`, and after 30 days. Numbers and verdicts stay. Cases whose request was deleted are
  never shown for review.
- **Cost.** One model call per case, cached by content. Replay runs two cases per cron minute from
  an operator-started queue (at most 200), so an idle concierge costs one settings read a minute.
  The daily free Workers AI allowance bounds how many cases a day are possible; check the current
  allowance and the model's price in neurons before large runs.

## Sequence

1. **Replay (built):** `/concierge run`, review cases, read the report: how many requests really
   went unanswered, how many of those the concierge could have handled, how often its routing
   found the person who really helped.
2. **Suggest mode, live:** new requests get a proposed next step; a person approves each with one
   tap. Acceptance by action type keeps feeding the same gate.
3. **Autonomy per action** once the gate opens for it, behind the owner's configuration, with the
   outbox's at-most-once sends and audit log, and a kill switch (`CONCIERGE_MODEL=off`).

## Not decided here

The live agent loop, the helper consent screen for autonomous asks, web search for outside
resources, and how the concierge is priced. Each needs its own evidence from steps 1–2.

## Risks

- **Prompt injection:** messages are untrusted input to an agent that will eventually message
  people. Defence is structural: a fixed action set, code-side policy and caps that hold even if the
  model is fooled. Tests feed it hostile output.
- **Confident wrong answers:** verified quotes or no answer.
- **Proxy outcomes:** "someone replied" is not "the request was resolved". The replay uses it only
  as a floor; live mode measures resolution with the member's own «Помогло?».
- **Model quality in Russian** varies across Workers AI models; the replay is how to compare them.

## Build record (2026-10-28, second slice)

- **One board, not one feature per notification.** The owner gets one card a day, sections for each
  kind of decision, and each decision is a single tap. Decisions are checked against the group they
  belong to (`concierge/board.ts`). This is what removes admin load: the owner reads one card, and
  nothing is sent on a day with nothing to decide.
- **Every decision is a case.** Replay, live suggestions, join admission, spam removal and best answers
  all write one row to `concierge_cases`, judged by a person. One record means one gate, so "auto" is
  earned the same way for AI and for rules. The gate reads each action's record only within its
  own version (`gate.ts`).
- **Rules are not AI.** Join admission, spam removal and best answers are deterministic and quote
  only existing text. They still have a ceiling and a review record. Admission and removal can
  become automatic; best answers can't, because the club's canonical answer stays the owner's call.
- **Screening answers are personal, so they're short-lived.** They are kept only while the decision
  is open, deleted on `/forget_me`, and never shown to anyone but admins of that group.
- **No new consent is assumed.** Join screening states what its third answer does. Introduction rounds
  need an explicit `/rounds on` and `/optin` first. Spam flags never leave the admins.
- **Known gaps, by design:** the spam guard doesn't see account age or lookalike names (Telegram does
  not expose them to bots); best answers are topic-level; hints are per group; automatic decisions are
  logged but not re-reviewed.

## Build record (2026-10-28, third slice: jobs)

- **Measure the jobs before building for them.** `/jobs` counts what a club is asked, by kind, from
  stored messages (`concierge/jobs.ts`): answered, how soon, thanked, bumped and asked again. The
  replay's sibling, not a new model step, so the prompt version and the autonomy record stay as they were.
- **Recommendations come from words that already exist.** A reply that points at a person or a service
  for the same topic is quoted with its date and link, from groups the asker can read. Nothing is
  ranked, scored or named unless that person opted in.
- **Hiring asks one question, then invites people who opted in to projects.** The request routes through
  the existing introduction state machine with a filter (`needs.want`, `openWork` in `eligibleCandidates`).
  Consent stays where it was: `/optin`, then `/open on`.
- **Introductions on request are matched on a line people wrote about their doors.** The line is matched,
  never shown, and only in groups whose owner switched the feature on after the census showed the need.
- **A deal counts only when both sides confirm it.** The proposal and the confirmation are rows in `deals`;
  a confirmed deal closes the request as solved, and the card names it.
- **Newcomers without contact** are a board item, not a message: one press runs this week's round or
  sends the onboarding card, once a week per group. Nobody who didn't opt in is reached by a round.
- **Known gaps:** partner and investor requests are counted but have no path of their own yet; the census
  reads at most 4,000 requests and 20,000 replies; newcomers are members new to the bot, not to the group.
