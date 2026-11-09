# Standalone Telegram chat exporter

`/export` is a second Telegram Mini App, independent of the community app at `/app`. It exports the
full history available to the signed-in user's own Telegram account from any basic group,
supergroup, or channel. The bot does **not** need to be in that chat, and the user does not need to
be a Telepathy community member or group administrator.

## Register it in Telegram

Deploy the Worker as usual, then register `https://YOUR-WORKER/export` as a Mini App URL in
BotFather (or add a bot button/link pointing to it). Do not replace the existing community app's
`/app` menu URL unless that is intentional. `POST /admin/setup` reports both URLs.

The tool uses the optional `TG_API_ID` and `TG_API_HASH` already supported by the history importer.
If these are not configured, each user enters their own keys from
[my.telegram.org](https://my.telegram.org/apps). Keys entered manually stay in that browser's local
storage. The optional configured keys are returned only to requests with valid, fresh Telegram
Mini App `initData`.

## What it does

1. Signs the user into Telegram directly over Telegram WebSocket endpoints with mtcute. Phone codes,
   cloud passwords, and the temporary session remain in the tab's memory and never reach the Worker.
2. Lists group/channel dialogs, also accepting a public username or numeric chat ID. As a shortcut,
   forward any group/channel message to the bot in a private chat. Telegram's current
   `forward_origin` metadata (or legacy `forward_from_chat`) supplies the source chat ID; the bot
   replies with an **Open chat exporter** button that preselects that chat. Forwarded user messages
   are ignored by this shortcut. The deep link is only a navigation hint—not proof of access—and
   the user's own MTProto session still enforces Telegram membership and permissions. The bot does
   not join, read, ingest, or answer questions about the forwarded source message.
3. Optionally restricts the selection by an inclusive **From** date, exclusive **Until** date, or
   positive message limit. **Lean messages only** prefilters out service events and emits just the
   chat identity and each message's `id`, `text`, ISO `date`, author (`from`, `from_id`, optional
   `from_username`), and optional `reply_to_message_id`, `forwarded_from`, and `topic_id`. Lean ZIPs
   contain only `result.json`: no service events, media, reactions, entities, edit metadata, export
   statistics, or null optional fields. Full, unfiltered exports show an estimated total and
   determinate progress; date-filtered and lean exports avoid a misleading total.
4. Reads history with Telegram pagination and creates `result.json` locally using the
   [Telegram Desktop single-chat schema](https://core.telegram.org/import-export): root `name`,
   `type`, `id`, `messages`, and message fields including `date_unixtime`, `from_id`, `edited`,
   `text_entities`, `forwarded_from`, reactions, and standard media fields. Telepathy extensions add
   sender usernames, outgoing state, forum topics, grouped media IDs, and safe media metadata.
   **Media files themselves are not downloaded**; `file`/`photo` contain Telegram's standard
   not-included placeholder. Raw Telegram access hashes are never serialized.
5. Sorts messages by ID and creates a ZIP locally using fflate. The ZIP contains `result.json`, a
   small `metadata.json` summary, and a README describing the format and privacy implications. A
   recovery copy is stored in this browser's IndexedDB until it is replaced or explicitly deleted;
   it never goes to Telepathy. Reopening `/export` offers that ZIP without requiring Telegram
   sign-in. Ordinary browsers download the local blob directly. Telegram WebViews cannot download
   blob URLs, so their **Download ZIP** action uploads the existing ZIP to tmpfiles after explicit
   confirmation and passes the resulting HTTPS URL to Telegram's native `downloadFile` method.
   Where supported, **Share ZIP** offers the local file through the device share sheet instead.
6. If the user explicitly selects tmpfiles and confirms the public-link warning, uploads the ZIP
   directly from the browser to `https://tmpfiles.org/api/v1/upload`, then displays the `/dl/`
   download URL. Archives above 100 MiB are not uploaded. An upload failure never discards the local
   download or recovery copy. **Upload again for a fresh link** remains available after success or
   expiry and always reuses the finished ZIP; it never reads the Telegram history again.
7. Logs out and destroys the temporary Telegram session when the user finishes. Closing the tab also
   attempts cleanup; if offline, the user can revoke the session in Telegram **Settings → Devices**.

Chat messages and archives never enter Telepathy D1 or pass through the Telepathy Worker. Telegram
and (only after consent) tmpfiles are the sole external data recipients. tmpfiles links should be
treated as public; retention and deletion are governed by tmpfiles, not Telepathy. Export only chats
you are entitled to copy.

Large chats are held in browser memory to produce the JSON and ZIP, so very large histories can be
limited by the device. **Stop and keep partial export** creates a valid archive of what was read.
History pages are fetched sequentially with a resumable cursor. `FLOOD_WAIT` responses show a
countdown, wait for Telegram's full requested delay, and retry the same page automatically; they do
not restart the export. Transient network/server failures use bounded exponential backoff. If the
connection still cannot recover, any messages already read are delivered in a clearly labelled
partial ZIP rather than discarded. Stopping also cancels an active countdown immediately.

Following Telegram Desktop, chats marked as protected from copying/forwarding are refused, and any
individually protected messages are excluded and counted in the archive metadata.

## Reference comparison

The implementation was checked against Telegram's official schema, Telegram macOS's ChatExportUI,
and Telegram Toolset's LLM Context Export. It adopts the official JSON field names, date filters,
incremental progress, safe filenames, archive metadata, and protected-content behavior. Media
downloads, HTML output, persistent IndexedDB backups, and multi-chat/full-account exports remain
intentionally out of scope for this small single-chat Mini App.

## Development

`npm run build:history` builds both browser bundles (`history/` and `export/`) and copies mtcute's
WASM files next to each bundle. Wrangler runs this automatically for dev/deploy. Generated bundles
are ignored by Git.

```bash
cd worker
npm run typecheck
npm test -- --run test/export.test.ts
```
