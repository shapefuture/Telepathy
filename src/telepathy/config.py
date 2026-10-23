"""Settings from environment. Secrets are never logged or included in repr (P11-04)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import time
from pathlib import Path
from zoneinfo import ZoneInfo


def _int(e: dict[str, str], key: str, default: int) -> int:
    raw = e.get(key, "").strip()
    return int(raw) if raw else default


@dataclass(frozen=True)
class Settings:
    bot_token: str = field(repr=False)
    db_path: Path
    owner_telegram_ids: frozenset[int]
    community_id: str
    community_label: str
    timezone: ZoneInfo
    digest_time: time = time(9, 0)
    retention_days: int = 90
    backup_dir: Path = Path("./data/backups")
    backup_keep: int = 14
    # Optional command run after each backup, e.g. an encrypted off-host copy.
    # The backup path is passed as the last argument. Never put secrets here; use env.
    backup_command: str = field(default="", repr=False)
    ask_rate_per_minute: int = 10

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Settings:
        e = dict(os.environ) if env is None else env
        token = e.get("TELEPATHY_BOT_TOKEN", "").strip()
        if not token:
            raise RuntimeError("TELEPATHY_BOT_TOKEN is not set")
        owners_raw = e.get("TELEPATHY_OWNER_IDS", "")
        owners = frozenset(int(x) for x in owners_raw.replace(" ", "").split(",") if x)
        if not owners:
            raise RuntimeError("TELEPATHY_OWNER_IDS must list at least one Telegram user ID")
        hh, mm = (e.get("TELEPATHY_DIGEST_TIME", "09:00") or "09:00").split(":")
        return cls(
            bot_token=token,
            db_path=Path(e.get("TELEPATHY_DB_PATH", "./data/telepathy.db")),
            owner_telegram_ids=owners,
            community_id=e.get("TELEPATHY_COMMUNITY_ID", "default"),
            community_label=e.get("TELEPATHY_COMMUNITY_LABEL", "Community"),
            timezone=ZoneInfo(e.get("TELEPATHY_TIMEZONE", "Asia/Jerusalem")),
            digest_time=time(int(hh), int(mm)),
            retention_days=_int(e, "TELEPATHY_RETENTION_DAYS", 90),
            backup_dir=Path(e.get("TELEPATHY_BACKUP_DIR", "./data/backups")),
            backup_keep=_int(e, "TELEPATHY_BACKUP_KEEP", 14),
            backup_command=e.get("TELEPATHY_BACKUP_COMMAND", ""),
            ask_rate_per_minute=_int(e, "TELEPATHY_ASK_RATE_PER_MINUTE", 10),
        )
