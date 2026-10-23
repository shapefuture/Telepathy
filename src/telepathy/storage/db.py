"""SQLite connection and forward-only migrations (P02-09)."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from importlib import resources
from pathlib import Path

from telepathy.domain.types import new_id, to_iso, utcnow

PRAGMAS = (
    "PRAGMA journal_mode=WAL",
    "PRAGMA foreign_keys=ON",
    "PRAGMA busy_timeout=5000",
    "PRAGMA synchronous=NORMAL",
)


def connect(path: Path | str) -> sqlite3.Connection:
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    # isolation_level=None: we manage transactions explicitly with BEGIN IMMEDIATE.
    conn = sqlite3.connect(str(path), isolation_level=None)
    conn.row_factory = sqlite3.Row
    for p in PRAGMAS:
        conn.execute(p)
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Single-writer transaction. Rolls back on any exception."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def _migrations() -> list[tuple[str, str]]:
    pkg = resources.files("telepathy.storage.migrations")
    files = sorted((p for p in pkg.iterdir() if p.name.endswith(".sql")), key=lambda p: p.name)
    return [(p.name.removesuffix(".sql"), p.read_text(encoding="utf-8")) for p in files]


def migrate(conn: sqlite3.Connection) -> list[str]:
    """Apply pending migrations in order. Returns the IDs applied."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations("
        "id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    done = {r[0] for r in conn.execute("SELECT id FROM schema_migrations")}
    applied: list[str] = []
    for mig_id, sql in _migrations():
        if mig_id in done:
            continue
        # executescript commits implicitly; wrap so a failed migration leaves no partial state.
        try:
            conn.executescript(
                "BEGIN IMMEDIATE;\n"
                + sql
                + f"\nINSERT INTO schema_migrations(id, applied_at) VALUES ('{mig_id}', "
                f"'{to_iso(utcnow())}');\nCOMMIT;"
            )
        except sqlite3.Error:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        applied.append(mig_id)
    return applied


def ensure_community(
    conn: sqlite3.Connection, community_id: str, label: str, timezone: str
) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO communities(id, label, timezone, created_at) VALUES (?,?,?,?)",
        (community_id, label, timezone, to_iso(utcnow())),
    )


def audit(
    conn: sqlite3.Connection,
    action: str,
    *,
    actor_member_id: str | None = None,
    subject: str | None = None,
    detail_json: str | None = None,
) -> None:
    conn.execute(
        "INSERT INTO audit_log(at, actor_member_id, action, subject, detail_json) "
        "VALUES (?,?,?,?,?)",
        (to_iso(utcnow()), actor_member_id, action, subject, detail_json),
    )


__all__ = ["audit", "connect", "ensure_community", "migrate", "new_id", "transaction"]
