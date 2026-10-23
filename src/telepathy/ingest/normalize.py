"""Normalize a Telegram Bot API Message dict (P03-04).

Input is the raw Bot API JSON shape (or aiogram's `model_dump(by_alias=True)`), so this
module has no SDK dependency. Names, usernames, phone numbers and contact cards are
dropped here and never reach storage.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

from telepathy.domain.types import to_iso

MEDIA_KINDS = ("photo", "document", "video", "voice", "audio", "video_note", "animation", "sticker")


@dataclass(frozen=True, slots=True)
class NormalizedMessage:
    platform: str
    chat_id: int
    message_id: int
    edit_version: int  # Telegram edit_date as unix seconds; 0 for the original
    sender_tg_id: int | None
    sender_is_bot: bool
    text: str
    event_at: str
    edited_at: str | None
    topic_id: int | None
    reply_to_message_id: int | None
    chat_username: str | None
    chat_title: str | None
    media_kind: str | None
    media_file_id: str | None

    @property
    def dedup_key(self) -> str:
        """(source_platform, chat_id, message_id, edit_revision) — P03-03."""
        return f"{self.platform}:{self.chat_id}:{self.message_id}:{self.edit_version}"

    def minimized(self) -> dict[str, Any]:
        """What we persist in raw_events: no display names, no sender usernames."""
        return asdict(self)


def _ts(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, int | float):
        return datetime.fromtimestamp(value, UTC)
    if isinstance(value, str):
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=UTC)
    raise ValueError(f"unsupported timestamp {value!r}")


def _media(msg: dict[str, Any]) -> tuple[str | None, str | None]:
    for kind in MEDIA_KINDS:
        item = msg.get(kind)
        if not item:
            continue
        if isinstance(item, list):  # photo sizes: keep the largest
            item = item[-1]
        return kind, item.get("file_id") if isinstance(item, dict) else None
    return None, None


def normalize_message(msg: dict[str, Any], *, platform: str = "telegram") -> NormalizedMessage:
    chat = msg["chat"]
    sender = msg.get("from") or msg.get("from_user") or {}
    edit_date = msg.get("edit_date")
    edit_dt = _ts(edit_date) if edit_date else None
    reply = msg.get("reply_to_message") or {}
    media_kind, media_file_id = _media(msg)
    topic_id = msg.get("message_thread_id") if msg.get("is_topic_message") else None
    return NormalizedMessage(
        platform=platform,
        chat_id=int(chat["id"]),
        message_id=int(msg["message_id"]),
        edit_version=int(edit_dt.timestamp()) if edit_dt else 0,
        sender_tg_id=int(sender["id"]) if sender.get("id") is not None else None,
        sender_is_bot=bool(sender.get("is_bot", False)),
        text=(msg.get("text") or msg.get("caption") or ""),
        event_at=to_iso(_ts(msg["date"])),
        edited_at=to_iso(edit_dt) if edit_dt else None,
        topic_id=int(topic_id) if topic_id is not None else None,
        reply_to_message_id=int(reply["message_id"]) if reply.get("message_id") else None,
        chat_username=chat.get("username"),
        chat_title=chat.get("title"),
        media_kind=media_kind,
        media_file_id=media_file_id,
    )


def citation_uri(
    chat_id: int, message_id: int, username: str | None, topic_id: int | None = None
) -> str | None:
    """t.me deep link (P06-05). Private-group links only resolve for chat members."""
    if username:
        return f"https://t.me/{username}/{message_id}"
    s = str(chat_id)
    if s.startswith("-100"):
        internal = s[4:]
        if topic_id:
            return f"https://t.me/c/{internal}/{topic_id}/{message_id}"
        return f"https://t.me/c/{internal}/{message_id}"
    return None  # basic groups have no message links
