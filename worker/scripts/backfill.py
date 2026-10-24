# /// script
# requires-python = ">=3.10"
# dependencies = ["telethon>=1.36"]
# ///
"""Fetch a chat's past messages with your own Telegram account, no Desktop export needed.

Runs on YOUR computer only. The login session and the messages never leave it until you
import the SQL into your own D1 database. Nothing is sent to any AI or third party.

  1. Get api_id and api_hash at https://my.telegram.org -> "API development tools".
  2. export TG_API_ID=... TG_API_HASH=...
  3. uv run scripts/backfill.py --chat @mygroup            # first run asks for your phone + code
  4. npm run import -- backfill/<chat>.json                 # same importer as Desktop exports
  5. npx wrangler d1 execute telepathy --remote --file import/part-001.sql   (one per day on free plan)

Run it again later: it only fetches messages newer than the last run (checkpoint file).
Only chats enabled with /enable are stored; members who used /forget_me are skipped.
"""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from telethon import TelegramClient
from telethon.tl.types import PeerUser

p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
p.add_argument("--chat", required=True, help="@username, invite link, or numeric chat id")
p.add_argument("--limit", type=int, default=0, help="max messages this run (0 = all)")
p.add_argument("--out", default="backfill", help="output folder (default: backfill)")
p.add_argument("--session", default=os.path.expanduser("~/.telepathy-backfill"), help="where your login is kept")
p.add_argument("--full", action="store_true", help="ignore the checkpoint and fetch everything again")
a = p.parse_args()

api_id, api_hash = os.environ.get("TG_API_ID"), os.environ.get("TG_API_HASH")
if not api_id or not api_hash:
    sys.exit("Set TG_API_ID and TG_API_HASH (from https://my.telegram.org).")


def bot_api_id(entity) -> int:
    """Telethon ids are bare; the bot stores supergroups/channels as -100<id> and groups as -<id>."""
    cls = type(entity).__name__
    if cls == "Channel":
        return int(f"-100{entity.id}")
    if cls == "Chat":
        return -entity.id
    return entity.id


async def main() -> None:
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    async with TelegramClient(a.session, int(api_id), api_hash) as client:
        target = int(a.chat) if a.chat.lstrip("-").isdigit() else a.chat
        entity = await client.get_entity(target)
        chat_id = bot_api_id(entity)
        name = f"chat{abs(chat_id)}"
        ckpt_file = out / f"{name}.checkpoint"
        min_id = 0 if a.full or not ckpt_file.exists() else int(ckpt_file.read_text().strip() or 0)

        messages, top = [], min_id
        async for m in client.iter_messages(entity, min_id=min_id, limit=a.limit or None, reverse=True):
            top = max(top, m.id)
            text = m.message or ""
            if not text.strip():
                continue  # media without caption, service messages
            item = {
                "id": m.id,
                "type": "message",
                "date_unixtime": str(int(m.date.timestamp())),
                "text": text,
            }
            if m.edit_date:
                item["edited_unixtime"] = str(int(m.edit_date.timestamp()))
            if m.reply_to and m.reply_to.reply_to_msg_id:
                item["reply_to_message_id"] = m.reply_to.reply_to_msg_id
            if isinstance(m.from_id, PeerUser):
                item["from_id"] = f"user{m.from_id.user_id}"
            messages.append(item)
            if len(messages) % 1000 == 0:
                print(f"  {len(messages)} messages...", flush=True)

        # Same shape as a Telegram Desktop export, so the existing importer handles it.
        suffix = f"-from{min_id}" if min_id else ""
        dump = out / f"{name}{suffix}.json"
        dump.write_text(json.dumps({"id": chat_id, "type": "backfill", "messages": messages}, ensure_ascii=False))
        ckpt_file.write_text(str(top))
        print(f"{len(messages)} text messages from {getattr(entity, 'title', a.chat)} -> {dump}")
        print(f"Next: npm run import -- {dump} --chat-id {chat_id}")


asyncio.run(main())
