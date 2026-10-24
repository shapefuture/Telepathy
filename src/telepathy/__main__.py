"""Entry point.

telepathy               run the bot (default)
telepathy migrate       apply migrations and exit
telepathy import FILE [--chat-id ID]   import a Telegram Desktop result.json
telepathy backup        write a verified online backup now
telepathy verify FILE   integrity-check a backup file
telepathy status        print operational metrics
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # aiogram logs request URLs at DEBUG, which include the bot token. Keep it at INFO+.
    logging.getLogger("aiogram").setLevel(logging.INFO)

    ap = argparse.ArgumentParser(prog="telepathy")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("run")
    sub.add_parser("migrate")
    imp = sub.add_parser("import")
    imp.add_argument("file", type=Path)
    imp.add_argument("--chat-id", type=int, default=None)
    sub.add_parser("backup")
    ver = sub.add_parser("verify")
    ver.add_argument("file", type=Path)
    sub.add_parser("status")
    args = ap.parse_args(argv)

    from telepathy.ops.backup import verify

    if args.cmd == "verify":
        verdict = verify(args.file)
        print(verdict)
        return 0 if verdict == "ok" else 1

    from telepathy.bot.app import open_database, run
    from telepathy.config import Settings

    settings = Settings.from_env()
    if args.cmd in (None, "run"):
        asyncio.run(run(settings))
        return 0
    conn = open_database(settings)
    try:
        if args.cmd == "migrate":
            print("ok")
        elif args.cmd == "import":
            from telepathy.ingest.importer import import_export

            rep = import_export(conn, settings.community_id, args.file, args.chat_id)
            print(json.dumps({"seen": rep.seen, **rep.outcomes}))
        elif args.cmd == "backup":
            from telepathy.domain.types import utcnow
            from telepathy.ops.backup import backup

            res = backup(
                conn,
                settings.backup_dir,
                utcnow(),
                keep=settings.backup_keep,
                command=settings.backup_command,
            )
            print(f"{res.path} {res.sha256} {res.integrity}")
            return 0 if res.integrity == "ok" else 1
        elif args.cmd == "status":
            from telepathy.ops.status import collect_status

            print(json.dumps(collect_status(conn, settings), indent=2, default=str))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
