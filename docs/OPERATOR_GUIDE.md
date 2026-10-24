# Operator guide: the assistance desk and partner gateway

Everything here is DM-only and for owners listed in `OWNER_IDS`.

## How a request flows

1. A member sends `/help <what they need>` and confirms the draft. That allows **local**
   processing only: search their groups, and show the summary to you.
2. If the groups answer it, they press **Solved** (closed, receipt `knowledge_answer`).
   Otherwise **I still need help** puts it on your desk and you get a card.
3. You choose one:
   - **Assign: <offer>** — one of your published offers with a free slot. The slot is taken
     atomically; the member is told it's confirmed. Afterwards press **Delivered** (or
     **Release slot** if it fell through).
   - **Start intro** — the existing consent-based intro (`/intro`) with this summary.
   - **Ask partners** — only shown when the member allowed sharing (they see a preview of exactly
     what partners get: type and summary, nothing else) and federation is on.
   - **No provider** — closes it and tells the member plainly.
4. After delivery the member is asked **Useful / Not useful**. `/desk report` shows every stage
   separately; unverified outcomes are not counted as success.

## Commands

| Command | What it does |
|---|---|
| `/desk` | open requests, partner requests waiting for you, messages to carry by hand |
| `/desk report` | missions by stage, receipts by evidence level, useful/not useful |
| `/offer add <skill> <slots> [volunteer\|paid\|reciprocal\|member_benefit] <description>` | publish capacity (90 days) |
| `/offer` · `/offer withdraw <id>` | list · withdraw |
| `/partner add <https origin> <public key> <skills,…\|*> <name>` | partner with a live endpoint |
| `/partner manual <id> <public key> <skills\|*> <name>` | partner without an endpoint (E0: you carry messages) |
| `/partner` · `/partner suspend <id>` | list · stop talking to a partner (their messages are refused at once) |
| `/fed <signed json>` | load a message a manual partner sent you |

## Connecting a partner

1. Both sides: `npm run fed:keys`, store the private key with `npx wrangler secret put
   FEDERATION_PRIVATE_KEY`, put the public key in `FEDERATION_PUBLIC_KEY`, set
   `FEDERATION_ENABLED` to `"true"` and `PUBLIC_URL`, then deploy.
2. Agree the partner constitution (`PARTNER_CONSTITUTION.md`) and which skill categories each side
   accepts.
3. Exchange public keys over a trusted channel, then each side runs `/partner add`.
4. Check: `curl https://<partner>/.well-known/nexus-node.json` shows their key and categories.

**Manual mode** needs no endpoint: when you route to a manual partner, `/desk` shows a signed
JSON message. Send it to their operator (they load it with `/fed`), press **Marked sent**, and
load their replies with `/fed`.

## When a partner asks you

You get **Request from <partner>** with the type and summary only. Press **Offer: <your offer>**
or **Decline**. If their member chooses your offer, your slot is reserved and you receive the
member's Telegram contact for your helper; press **Delivered** when done. If they withdraw, the
contact and summary are deleted from your node and the slot is returned.
