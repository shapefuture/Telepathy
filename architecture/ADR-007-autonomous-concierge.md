# ADR-007: Autonomous concierge on Workers AI — a permission envelope, earned autonomy

**Status:** accepted for the prototype (2026-10-28); first slice built (history replay and review).
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
