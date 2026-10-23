"""Settings from environment. Secrets are never logged or included in repr (P11-04)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class Settings:
    bot_token: str = field(repr=False)
    db_path: Path
    owner_telegram_ids: frozenset[int]
    community_id: str
    community_label: str
    timezone: ZoneInfo

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Settings:
        e = dict(os.environ) if env is None else env
        token = e.get("TELEPATHY_BOT_TOKEN", "").strip()
        if not token:
            raise RuntimeError("TELEPATHY_BOT_TOKEN is not set")
        owners_raw = e.get("TELEPATHY_OWNER_IDS", "")
        owners = frozenset(int(x) for x in owners_raw.replace(" ", "").split(",") if x)
        return cls(
            bot_token=token,
            db_path=Path(e.get("TELEPATHY_DB_PATH", "./data/telepathy.db")),
            owner_telegram_ids=owners,
            community_id=e.get("TELEPATHY_COMMUNITY_ID", "default"),
            community_label=e.get("TELEPATHY_COMMUNITY_LABEL", "Community"),
            timezone=ZoneInfo(e.get("TELEPATHY_TIMEZONE", "Asia/Jerusalem")),
        )
