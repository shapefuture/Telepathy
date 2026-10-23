"""Telegram handlers (P03-01, P03-02, P06-01).

Rules enforced here:
  * group messages are ingested only for chats an owner explicitly enabled
  * /ask is answered only in private chat, using the caller's verified Telegram ID
  * the bot never replies in groups except to owner admin commands
"""

from __future__ import annotations

import logging
import sqlite3
from typing import Any

from aiogram import F, Router
from aiogram.enums import ChatMemberStatus, ChatType, ParseMode
from aiogram.filters import Command, CommandObject
from aiogram.types import ChatMemberUpdated, LinkPreviewOptions, Message

from telepathy.config import Settings
from telepathy.domain.types import Role, Visibility
from telepathy.ingest.normalize import normalize_message
from telepathy.ingest.service import (
    IngestOutcome,
    disable_source,
    enable_source,
    get_enabled_source,
    ingest,
)
from telepathy.retrieval.answer import answer, render_html
from telepathy.storage import acl

log = logging.getLogger(__name__)
router = Router(name="telepathy")

GROUP_TYPES = {ChatType.GROUP, ChatType.SUPERGROUP}
NO_PREVIEW = LinkPreviewOptions(is_disabled=True)

PRIVACY_NOTICE = (
    "<b>Telepathy privacy notice</b>\n"
    "• This bot stores messages only from groups an owner explicitly enabled.\n"
    "• Your name, username and phone number are not stored; you get a random internal ID.\n"
    "• Answers quote messages verbatim with a link, and only from groups you can read.\n"
    "• Nothing is sent to external AI services unless the community approved it.\n"
    "• You are not discoverable as an expert unless you opt in yourself."
)
ENABLED_NOTICE = (
    "Telepathy is now <b>collecting</b> this chat (visibility: {vis}). "
    "Members can search it privately via /ask in a DM with the bot. "
    "Send /privacy to the bot for details. An owner can stop this with /disable."
)


def _is_owner(settings: Settings, message: Message) -> bool:
    return message.from_user is not None and message.from_user.id in settings.owner_telegram_ids


async def _is_chat_admin(message: Message) -> bool:
    if message.from_user is None or message.bot is None:
        return False
    cm = await message.bot.get_chat_member(message.chat.id, message.from_user.id)
    return cm.status in (ChatMemberStatus.CREATOR, ChatMemberStatus.ADMINISTRATOR)


def _owner_member_id(conn: sqlite3.Connection, settings: Settings, tg_id: int) -> str:
    mid = acl.upsert_member(conn, settings.community_id, tg_id)
    conn.execute("UPDATE members SET role=? WHERE id=?", (Role.OWNER.value, mid))
    return mid


# ---- Owner commands (groups) -------------------------------------------------------------


@router.message(Command("enable"), F.chat.type.in_(GROUP_TYPES))
async def cmd_enable(
    message: Message, command: CommandObject, conn: sqlite3.Connection, settings: Settings
) -> None:
    # Two independent checks: configured community owner AND current chat admin.
    if not _is_owner(settings, message) or not await _is_chat_admin(message):
        return  # silent: do not advertise admin commands to non-owners
    arg = (command.args or Visibility.MEMBER_CONSENTED.value).strip().upper()
    try:
        vis = Visibility(arg)
    except ValueError:
        await message.reply("Visibility must be one of: " + ", ".join(v.value for v in Visibility))
        return
    if vis is Visibility.PRIVATE_UNKNOWN:
        await message.reply("PRIVATE_UNKNOWN sources cannot be enabled.")
        return
    assert message.from_user is not None
    owner_id = _owner_member_id(conn, settings, message.from_user.id)
    enable_source(
        conn,
        settings.community_id,
        message.chat.id,
        visibility=vis,
        enabled_by_member_id=owner_id,
        title=message.chat.title,
        public_username=message.chat.username,
    )
    await message.reply(ENABLED_NOTICE.format(vis=vis.value), parse_mode=ParseMode.HTML)


@router.message(Command("disable"), F.chat.type.in_(GROUP_TYPES))
async def cmd_disable(message: Message, conn: sqlite3.Connection, settings: Settings) -> None:
    if not _is_owner(settings, message) or not await _is_chat_admin(message):
        return
    assert message.from_user is not None
    owner_id = _owner_member_id(conn, settings, message.from_user.id)
    if disable_source(conn, settings.community_id, message.chat.id, actor_member_id=owner_id):
        await message.reply(
            "Telepathy stopped collecting this chat. Existing messages are "
            "excluded from all answers."
        )


# ---- Member commands (private chat only) -------------------------------------------------


@router.message(Command("start"), F.chat.type == ChatType.PRIVATE)
async def cmd_start(message: Message) -> None:
    await message.answer(
        "Hi! I search your community's enabled groups and answer with cited quotes.\n\n"
        "<code>/ask how do we register for the meetup?</code>\n\n" + PRIVACY_NOTICE,
        parse_mode=ParseMode.HTML,
    )


@router.message(Command("privacy"), F.chat.type == ChatType.PRIVATE)
async def cmd_privacy(message: Message) -> None:
    await message.answer(PRIVACY_NOTICE, parse_mode=ParseMode.HTML)


@router.message(Command("ask"), F.chat.type == ChatType.PRIVATE)
async def cmd_ask(
    message: Message, command: CommandObject, conn: sqlite3.Connection, settings: Settings
) -> None:
    if message.from_user is None:
        return
    # Identity comes from Telegram's signed update, never from the message text.
    ctx = acl.access_context(conn, settings.community_id, message.from_user.id)
    if ctx is None:
        await message.answer("I don't know you yet. Post in an enabled community group first.")
        return
    ans = answer(conn, ctx, command.args or "")
    await message.answer(
        render_html(ans, settings.timezone),
        parse_mode=ParseMode.HTML,
        link_preview_options=NO_PREVIEW,
    )


@router.message(Command("ask"), F.chat.type.in_(GROUP_TYPES))
async def cmd_ask_in_group(message: Message) -> None:
    # Answering in a group could show restricted evidence to people without access.
    await message.reply("Please send /ask to me in a private chat.")


# ---- Ingestion ---------------------------------------------------------------------------


def _dump(message: Message) -> dict[str, Any]:
    data: dict[str, Any] = message.model_dump(mode="json", by_alias=True, exclude_none=True)
    return data


async def _ingest(
    message: Message, conn: sqlite3.Connection, settings: Settings, event_update: Any = None
) -> None:
    try:
        nm = normalize_message(_dump(message))
    except (KeyError, ValueError):
        log.warning("unparseable message in chat %s", message.chat.id)
        return
    update_id = getattr(event_update, "update_id", None)
    outcome = ingest(conn, settings.community_id, nm, update_id=update_id)
    if outcome is not IngestOutcome.NOT_AUTHORIZED:
        log.debug("ingest chat=%s msg=%s -> %s", nm.chat_id, nm.message_id, outcome)


@router.message(F.chat.type.in_(GROUP_TYPES))
async def on_group_message(
    message: Message, conn: sqlite3.Connection, settings: Settings, event_update: Any = None
) -> None:
    await _ingest(message, conn, settings, event_update)


@router.edited_message(F.chat.type.in_(GROUP_TYPES))
async def on_group_edit(
    message: Message, conn: sqlite3.Connection, settings: Settings, event_update: Any = None
) -> None:
    await _ingest(message, conn, settings, event_update)


@router.chat_member()
async def on_chat_member(
    event: ChatMemberUpdated, conn: sqlite3.Connection, settings: Settings
) -> None:
    """Leaving or being removed from a group revokes read access to it (C06)."""
    src = get_enabled_source(conn, settings.community_id, "telegram", event.chat.id)
    if src is None:
        return
    member = acl.get_member_by_telegram(conn, settings.community_id, event.new_chat_member.user.id)
    if member is None:
        return
    if event.new_chat_member.status in (ChatMemberStatus.LEFT, ChatMemberStatus.KICKED):
        acl.revoke_source_access(conn, src.id, member.id)
    elif event.new_chat_member.status in (
        ChatMemberStatus.MEMBER,
        ChatMemberStatus.ADMINISTRATOR,
        ChatMemberStatus.CREATOR,
    ):
        acl.grant_source_access(conn, src.id, member.id, "chat_member")
