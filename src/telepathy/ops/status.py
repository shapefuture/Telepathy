"""Operational metrics (P11-03). Counts only: never message content or identities."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from typing import Any

from telepathy.config import Settings
from telepathy.domain.types import from_iso, utcnow


def _one(conn: sqlite3.Connection, sql: str, *args: Any) -> Any:
    row = conn.execute(sql, args).fetchone()
    return row[0] if row else None


def collect_status(
    conn: sqlite3.Connection, settings: Settings, now: datetime | None = None
) -> dict[str, Any]:
    now = now or utcnow()
    last_obs = _one(conn, "SELECT MAX(observed_at) FROM raw_events")
    lag = f"{int((now - from_iso(last_obs)).total_seconds())}s ago" if last_obs else "never"
    backups = (
        sorted(settings.backup_dir.glob("telepathy-*.db")) if settings.backup_dir.exists() else []
    )
    db_size = settings.db_path.stat().st_size if settings.db_path.exists() else 0
    return {
        "enabled sources": _one(conn, "SELECT COUNT(*) FROM sources WHERE enabled=1"),
        "members": _one(conn, "SELECT COUNT(*) FROM members WHERE removed_at IS NULL"),
        "discoverable experts": _one(conn, "SELECT COUNT(*) FROM members WHERE discovery_opt_in=1"),
        "live messages": _one(conn, "SELECT COUNT(*) FROM messages WHERE removed_at IS NULL"),
        "searchable excerpts": _one(conn, "SELECT COUNT(*) FROM excerpts WHERE valid_to IS NULL"),
        "documents": _one(conn, "SELECT COUNT(*) FROM documents WHERE removed_at IS NULL"),
        "documents needing OCR": _one(
            conn, "SELECT COUNT(*) FROM documents WHERE status='needs_ocr'"
        ),
        "last message seen": lag,
        "jobs pending": _one(conn, "SELECT COUNT(*) FROM jobs WHERE state IN ('pending','leased')"),
        "jobs failed": _one(conn, "SELECT COUNT(*) FROM jobs WHERE state IN ('failed','manual')"),
        "sends pending": _one(conn, "SELECT COUNT(*) FROM effect_intents WHERE state='pending'"),
        "sends uncertain": _one(
            conn, "SELECT COUNT(*) FROM effect_intents WHERE state='uncertain'"
        ),
        "sends failed": _one(conn, "SELECT COUNT(*) FROM effect_intents WHERE state='failed'"),
        "open intro requests": _one(
            conn, "SELECT COUNT(*) FROM needs WHERE status IN ('open','matching')"
        ),
        "intros connected": _one(
            conn,
            "SELECT COUNT(*) FROM introductions WHERE status IN "
            "('mutually_confirmed','scheduled','completed')",
        ),
        "schema": _one(conn, "SELECT MAX(id) FROM schema_migrations"),
        "db size": f"{db_size / 1e6:.1f} MB",
        "last backup": backups[-1].name if backups else "none",
    }
