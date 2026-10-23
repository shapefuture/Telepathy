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

**External services.** None. Messages are not sent to AI providers.

**Retention.** Full history is kept by default. Messages are removed only when you delete them
(`/forget_me`, or `/forget` on one message) or when a group owner sets a retention limit for that
group. Backups roll over after 14 days.

**Daily digest.** Off by default. Turn it on with `/digest on`. It summarises only the groups you
can read, and `/digest off` stops it at any time.

**Your controls.**
- `/profile`: see and change everything stored about your discoverability and your digest.
- `/optout`: stop being discoverable.
- Reply `/forget` to one of your messages in the group: delete that message.
- `/forget_me`: delete all your stored messages, skills and requests, and stop storing your
  future messages. `/resume_collection` undoes the stop.

**Contact.** [community owner contact here]
