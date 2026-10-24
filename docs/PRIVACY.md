# Telepathy privacy notice (member-facing draft)

> Draft for the community owner to adapt and approve (P00-10). Post it in each enabled group.

**What is collected.** Messages and files posted in groups that a community owner has
enabled for Telepathy. Each enabled group gets a notice from the bot. Nothing is collected
from other chats or from private messages, except the commands you send the bot.

**What is not stored.** Your name, username or phone number. You are stored under a random
internal ID. Photos and other media are kept only as Telegram file references. Supported
documents (PDF, Word, PowerPoint, text, subtitles) are turned into searchable text, and the
file itself is not kept.

**Who can see it.** Search answers quote messages only from groups the person searching can
read. Restricted groups are visible only to moderators. Nobody can browse your profile.

**Expert introductions.** You are never discoverable unless you run `/optin` and list your
skills. When someone asks for an introduction, you see their request without their name. Contact
details are exchanged only after **you accept and they confirm**.

**External services.** Messages are stored in Cloudflare (D1) and never sent to AI providers.
PDF, Word and PowerPoint files posted in an enabled group are converted to text on GitHub's
servers (GitHub Actions). The files are not kept or logged there; only the extracted text comes
back to Telepathy.

**Retention.** Full history is kept by default. Messages are removed only when you delete them
(`/forget_me`, or `/forget` on one message) or when a group owner sets a retention limit for that
group. Backups roll over after 14 days.

**Asking in a group.** `/ask` in a group answers only from that group's own messages,
which everyone there can already read. If the owner turned on hints, the bot may reply to a
question with a link to an earlier answer in the same group.

**Answer feedback.** 👍/👎 and "wrong source" buttons are private. Nobody sees who voted;
totals only nudge search ranking. `/forget_me` deletes your votes.

**Pings and suggestions.** If an owner turns on routing for a group, opted-in experts may get a
private link to an unanswered question in a group they already read. After you've answered
several questions on a topic, the bot may privately suggest adding it to your skills; nothing
changes unless you accept. `/pings off` stops question pings.

**Events and the app.** Upcoming events are detected from announcements and shown only to people
who can read those groups. The in-Telegram app uses your Telegram identity, which Telegram signs;
it shows the same data as the bot and collects nothing new.

**Daily digest.** Off by default. Turn it on with `/digest on`. It summarises only the groups you
can read, and `/digest off` stops it at any time.

**Requests for help (`/help`).** When you confirm a request, its summary is stored and the
community operators can see it, so they can help. It stays inside this community unless you
press **Allow sharing**, after a preview of exactly what partner communities would get: the type
of help and your summary, without your name, Telegram account, groups or messages. If you then
choose a partner's offer, your Telegram contact goes to that one partner, so their helper can
reach you. Cancelling a request (or `/forget_me`) tells partners to delete what they received;
we can't make a person forget what they already read. Requests expire after 30 days and
permissions after 14.

**Unserved needs.** Operators see when 5 or more different members needed the same kind of help
and nobody could provide it, as a rough count ("5+", "10+") without names, so they can arrange
new help. It never shows who asked.

**Passport (optional).** If you choose to, you can add an email address and recovery codes so you
can reach this community without Telegram. You pick what you receive (critical notices, events,
updates on your requests, news, community offers, partner offers), each separately, and can change
it any time in the app or the portal without Telegram. Your email address is stored encrypted and
is sent to our email provider [name it here] only to deliver what you chose. When you unsubscribe
or delete your passport, we keep a one-way fingerprint of the address so it can't be re-enabled by
a restore or an import; it identifies nothing else. A membership pass you create for a partner
shows only your membership level, under a pseudonym that differs for each partner.

**Your controls.**
- `/profile`: see and change everything stored about your discoverability and your digest.
- `/optout`: stop being discoverable.
- Reply `/forget` to one of your messages in the group: delete that message.
- `/requests`: see and cancel your open requests.
- `/forget_me`: delete all your stored messages, skills and requests, and stop storing your
  future messages. `/resume_collection` undoes the stop.

**Contact.** [community owner contact here]
