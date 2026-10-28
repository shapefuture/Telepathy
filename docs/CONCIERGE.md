# Concierge: checking it on your history

The concierge is an AI agent that takes a member's request and moves it to a result: an answer
from the club's memory, people who know, a clarifying question, or the club's team. It runs on
Cloudflare Workers AI only. Design and limits: `architecture/ADR-007-autonomous-concierge.md`.

**Right now it messages nobody.** This first step answers one question before it does: *would it
have helped?* It goes through your groups' past requests, decides what it would have done using
only what was written before each one, and compares that with what really happened. You judge its
decisions, and those judgements decide what it may later do on its own.

## Run it

1. Deploy with migration `0023_concierge.sql` (`npm run db:migrate:remote`). The `AI` binding is
   already in `wrangler.jsonc`.
2. In a private chat with the bot, as an operator (`OWNER_IDS`): `/concierge`.
3. Press **▶️ Replay 20** (or send `/concierge run 50`, at most 200). The cron works through two
   requests a minute and writes when it's done. Only groups you can read are used.
4. Press **📝 Review**. Each card shows the request, what really happened, and what the concierge
   would have done. Answer **✅ Right** or **❌ Wrong** (or skip). The card updates in place.
5. **📊 Report** shows:
   - requests replayed, and what it would have done with them;
   - how many really got no reply, and for how many of those it had a checked answer or people to
     ask (the help your members missed);
   - when it would have asked people and someone really replied, how often that person was among
     the ones it picked;
   - per action, your verdicts and the autonomy each action has now.

## Settings (`wrangler.jsonc` vars)

| Var | Meaning |
|---|---|
| `CONCIERGE_MODEL` | Workers AI model. Empty = the summaries' default (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`). `off` disables the concierge. Compare models by replaying with each. |
| `CONCIERGE_AUTONOMY` | What you allow, per action: `clarify`, `answer`, `ask_people`, `follow_up`, `escalate` (can reach `auto`), `introduce`, `ask_partners`, `paid_provider` (never above `suggest`). Example: `clarify:auto,answer:suggest`. Missing = off. |

`auto` takes effect for an action only after **50 reviewed cases with at least 90% judged right**.
Until then it behaves as `suggest`. This is enforced in code, so a setting can't skip it.

## What is sent to Workers AI, and what is kept

- **Sent:** the request and up to three short earlier conversations from the same group, redacted
  (no emails, phones, @usernames, links, tokens), with no names, ids or chat titles.
- **Kept:** one row per replayed request (`concierge_cases`) with the decision, counts and your
  verdict. The generated text is erased whenever any message or member is deleted, on retention
  purges, and after 30 days. No member ids are stored on a case.
- **AI summaries (`docs/AI.md`) are separate.** If `OLLAMA_API_KEY` is set, summaries go to Ollama
  Cloud first. To keep all AI on Cloudflare, leave it unset.

Tell members in your rules that an AI assistant reads requests to help route them.

## Reading the result

- Few requests went unanswered → the club already copes. The concierge should save the team's
  time, not rescue members, so measure that instead.
- Many unanswered and it had something for them → strong case for suggest mode.
- Routing rarely finds the real helper → the people side is the weak point. Ask helpers to state
  their topics (`/optin`) before trusting it to ask anyone.
- Many "wrong" verdicts on one action → keep that action off and look at the cases. Change the
  prompt (it bumps `PROMPT_VERSION`) or the model, and replay again.
