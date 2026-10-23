"""Entry point: `python -m telepathy` or `telepathy`."""

from __future__ import annotations

import asyncio
import logging


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # aiogram logs request URLs at DEBUG, which include the bot token. Keep it at INFO+.
    logging.getLogger("aiogram").setLevel(logging.INFO)

    from telepathy.bot.app import run
    from telepathy.config import Settings

    asyncio.run(run(Settings.from_env()))


if __name__ == "__main__":
    main()
