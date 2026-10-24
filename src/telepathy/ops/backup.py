"""Online SQLite backups (P11-05, P11-06).

Uses the SQLite backup API (safe while the bot is running in WAL mode), writes a
SHA-256 sidecar, verifies integrity, prunes old copies, and optionally hands the file
to an operator-configured command for encrypted off-host copy (e.g. `age` + `rclone`).
"""

from __future__ import annotations

import hashlib
import logging
import shlex
import sqlite3
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class BackupResult:
    path: Path
    sha256: str
    integrity: str


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def verify(path: Path) -> str:
    """Run integrity_check and confirm migrations table exists. Returns 'ok' or error."""
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        res = c.execute("PRAGMA integrity_check").fetchone()[0]
        if res != "ok":
            return str(res)
        c.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()
        return "ok"
    except sqlite3.Error as exc:
        return f"error: {exc}"
    finally:
        c.close()


def backup(
    conn: sqlite3.Connection, backup_dir: Path, now: datetime, *, keep: int = 14, command: str = ""
) -> BackupResult:
    backup_dir.mkdir(parents=True, exist_ok=True)
    dest = backup_dir / f"telepathy-{now.strftime('%Y%m%dT%H%M%SZ')}.db"
    tmp = dest.with_suffix(".db.partial")
    target = sqlite3.connect(tmp)
    try:
        conn.backup(target)
    finally:
        target.close()
    tmp.rename(dest)
    dest.chmod(0o600)
    digest = _sha256(dest)
    dest.with_suffix(".db.sha256").write_text(f"{digest}  {dest.name}\n")
    integrity = verify(dest)
    if integrity != "ok":
        log.error("backup %s failed integrity check: %s", dest.name, integrity)
    if command and integrity == "ok":
        # Operator-controlled command from env; argument list, no shell.
        subprocess.run([*shlex.split(command), str(dest)], check=True, timeout=600)  # noqa: S603
    _prune(backup_dir, keep)
    return BackupResult(dest, digest, integrity)


def _prune(backup_dir: Path, keep: int) -> None:
    files = sorted(backup_dir.glob("telepathy-*.db"))
    for old in files[:-keep] if keep > 0 else []:
        old.unlink(missing_ok=True)
        old.with_suffix(".db.sha256").unlink(missing_ok=True)
