"""Delivers outbox payloads via the Bot API, classifying failures honestly.

* 400/403 (blocked, chat not found): DefiniteFailure -> intent 'failed'
* 429 flood control: RetryLater -> intent back to 'pending'
* timeouts / network errors: propagate -> intent 'uncertain' (never auto-resent)
"""

from __future__ import annotations

import html
from typing import Any

from aiogram import Bot
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError, TelegramRetryAfter
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, LinkPreviewOptions

from telepathy.storage.outbox import DefiniteFailure, RetryLater


async def _contact_line(bot: Bot, tg_id: int) -> str:
    """Resolved live at send time; the username is never stored."""
    try:
        chat = await bot.get_chat(tg_id)
    except (TelegramBadRequest, TelegramForbiddenError):
        chat = None
    name = html.escape(chat.full_name if chat and chat.full_name else "Open profile")
    mention = f'<a href="tg://user?id={tg_id}">{name}</a>'
    if chat and chat.username:
        return f"{mention} · @{html.escape(chat.username)}"
    return mention


def make_sender(bot: Bot) -> Any:
    async def send(target: str, payload: dict[str, Any]) -> str:
        text = payload["text"]
        if payload.get("reveal_tg_id"):
            text += "\n" + await _contact_line(bot, int(payload["reveal_tg_id"]))
        markup = None
        if payload.get("buttons"):
            markup = InlineKeyboardMarkup(
                inline_keyboard=[
                    [InlineKeyboardButton(text=t, callback_data=d) for t, d in row]
                    for row in payload["buttons"]
                ]
            )
        try:
            msg = await bot.send_message(
                int(payload["chat_id"]),
                text,
                parse_mode=ParseMode.HTML,
                reply_markup=markup,
                link_preview_options=LinkPreviewOptions(is_disabled=True),
            )
        except TelegramRetryAfter as exc:
            raise RetryLater(f"retry after {exc.retry_after}s") from exc
        except (TelegramForbiddenError, TelegramBadRequest) as exc:
            raise DefiniteFailure(type(exc).__name__ + ": " + str(exc)[:200]) from exc
        return str(msg.message_id)

    return send


def make_fetcher(bot: Bot) -> Any:
    async def fetch(file_id: str) -> bytes:
        f = await bot.get_file(file_id)
        if f.file_path is None:
            raise RuntimeError("file has no download path")
        buf = await bot.download_file(f.file_path)
        if buf is None:
            raise RuntimeError("download returned nothing")
        return buf.read()

    return fetch
