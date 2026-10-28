# AI summaries (Beam, with Workers AI as backup)

The concierge (`docs/CONCIERGE.md`) is separate: it uses Workers AI only, never Beam.

When it's on, `/ask` answers (in private, in groups and in the Mini App) start with a 1–3 sentence
summary marked «Кратко от ИИ — сверься с источниками ниже». The found messages are still listed
underneath, as before.

Two models can write it, tried in this order:

1. **Beam on Ollama Cloud**, when `OLLAMA_API_KEY` is set.
2. **Cloudflare Workers AI** (binding `AI` in `wrangler.jsonc`), when Beam is not set up, down or out
   of free quota. Text goes to Cloudflare's own AI in your account, not to another company. It has a
   daily free allowance; when that's used up, answers simply appear without a summary until the next day.
   The default model is `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Set the var `WORKERS_AI_MODEL` to
   pick another, or to `off` to disable the backup.

Because the `AI` binding is in `wrangler.jsonc`, **summaries are on after deploy even without a Beam
key** (from Workers AI). To turn all AI summaries off, set `WORKERS_AI_MODEL` to `off` and don't set
`OLLAMA_API_KEY`.

To add Beam:

```bash
npx wrangler secret put OLLAMA_API_KEY    # from https://ollama.com/settings/keys
# optional vars: BEAM_MODEL=beam:cloud if your account needs that spelling
```

To remove Beam, delete the secret with `npx wrangler secret delete OLLAMA_API_KEY`.

## What is sent to Ollama or Workers AI

| Sent | Never sent |
| --- | --- |
| The question | Names, Telegram ids, chat ids or titles |
| Up to 4 short conversations behind the found messages (≤1800 characters each) | Emails, phone numbers, @usernames, links, tokens (masked as `[email]`, `[phone]`…) |
| | Messages the asker can't already read; messages of people who used `/forget_me` |

Masking catches contacts, not every personal detail inside a sentence. Ollama says it doesn't log or
train on cloud prompts, but Beam's free access is a time-limited promotion. Check their current
terms, and tell members in your rules that AI summaries are used.

## Safety checks

- **Quotes are checked word for word** against the conversations. Any quote that isn't there is
  removed before the member sees the summary.
- **Results are keyed by the exact text** (`ai_cache`). An edited or deleted message gives a new
  key, so an old summary is never reused. Cached results are dropped after 30 days.
- **Message text is data, not instructions.** The model is told so, and it can only produce text
  for the summary. It has no tools and can't take actions.
- **Any failure** (timeout, quota, outage) shows the normal answer without a summary.
