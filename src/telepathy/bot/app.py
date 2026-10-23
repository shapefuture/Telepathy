"""Bot process wiring: one supervisor, one token, long polling (P03-01)."""

from __future__ import annotations

import logging
import sqlite3

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties

from telepathy.bot.handlers import router
from telepathy.config import Settings
from telepathy.domain.types import utcnow
from telepathy.storage import db, outbox

log = logging.getLogger(__name__)

ALLOWED_UPDATES = ["message", "edited_message", "chat_member", "my_chat_member"]


def open_database(settings: Settings) -> sqlite3.Connection:
    conn = db.connect(settings.db_path)
    applied = db.migrate(conn)
    if applied:
        log.info("applied migrations: %s", ", ".join(applied))
    db.ensure_community(
        conn, settings.community_id, settings.community_label, settings.timezone.key
    )
    stuck = outbox.recover_after_crash(conn, now=utcnow())
    if stuck:
        log.warning("%d effect(s) marked uncertain after restart; reconcile manually", stuck)
    return conn


async def run(settings: Settings) -> None:
    conn = open_database(settings)
    bot = Bot(settings.bot_token, default=DefaultBotProperties(parse_mode=None))
    dp = Dispatcher()
    dp["conn"] = conn
    dp["settings"] = settings
    dp.include_router(router)
    try:
        await dp.start_polling(bot, allowed_updates=ALLOWED_UPDATES)
    finally:
        await bot.session.close()
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.close()
