"""Bot process wiring: one supervisor, one token, long polling + worker (P03-01)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import sqlite3

from aiogram import Bot, Dispatcher
from aiogram.types import BotCommand, BotCommandScopeAllPrivateChats, ErrorEvent

from telepathy.bot.handlers import router
from telepathy.bot.notifier import make_fetcher, make_sender
from telepathy.config import Settings
from telepathy.domain.types import utcnow
from telepathy.storage import acl, db, outbox
from telepathy.worker import Worker

log = logging.getLogger(__name__)

ALLOWED_UPDATES = ["message", "edited_message", "chat_member", "my_chat_member", "callback_query"]

COMMANDS = [
    BotCommand(command="ask", description="Search your groups with cited answers"),
    BotCommand(command="intro", description="Request a consent-based introduction"),
    BotCommand(command="expert", description="How many experts match a topic"),
    BotCommand(command="requests", description="Your open introduction requests"),
    BotCommand(command="profile", description="Your profile and settings"),
    BotCommand(command="digest", description="Turn the daily digest on or off"),
    BotCommand(command="skills", description="Manage your skills"),
    BotCommand(command="privacy", description="What is stored and why"),
    BotCommand(command="forget_me", description="Delete your data"),
    BotCommand(command="help", description="All commands"),
]


def open_database(settings: Settings) -> sqlite3.Connection:
    conn = db.connect(settings.db_path)
    applied = db.migrate(conn)
    if applied:
        log.info("applied migrations: %s", ", ".join(applied))
    db.ensure_community(
        conn, settings.community_id, settings.community_label, settings.timezone.key
    )
    # Configured owners receive digests and owner commands even before their first message.
    for tg in settings.owner_telegram_ids:
        mid = acl.upsert_member(conn, settings.community_id, tg)
        conn.execute("UPDATE members SET role='owner' WHERE id=?", (mid,))
    stuck = outbox.recover_after_crash(conn, now=utcnow())
    if stuck:
        log.warning("%d send(s) marked uncertain after restart; owners can /uncertain", stuck)
    return conn


async def run(settings: Settings) -> None:
    conn = open_database(settings)
    bot = Bot(settings.bot_token)
    dp = Dispatcher()
    dp["conn"] = conn
    dp["settings"] = settings
    dp.include_router(router)

    @dp.errors()
    async def on_error(event: ErrorEvent) -> bool:
        # Never echo internals to users; log with the update id only.
        log.error(
            "handler error on update %s: %r",
            event.update.update_id,
            event.exception,
            exc_info=event.exception,
        )
        return True

    worker = Worker(conn, settings, make_sender(bot), make_fetcher(bot))
    worker_task = asyncio.create_task(worker.run_forever(), name="telepathy-worker")
    try:
        await bot.set_my_commands(COMMANDS, scope=BotCommandScopeAllPrivateChats())
        await dp.start_polling(bot, allowed_updates=ALLOWED_UPDATES, handle_signals=True)
    finally:
        worker_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await worker_task
        await bot.session.close()
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.close()
        log.info("shutdown complete")
