"""Durable job ledger with leases (P02-07). No Redis.

* enqueue is idempotent on dedup_key
* lease atomically claims one due job; expired leases are reclaimable after a crash
* failures back off exponentially; after max_attempts the job goes to 'failed'
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from telepathy.domain.types import from_iso, new_id, to_iso


@dataclass(frozen=True, slots=True)
class Job:
    id: str
    kind: str
    dedup_key: str
    payload: dict[str, Any]
    attempts: int
    lease_owner: str


def enqueue(
    conn: sqlite3.Connection,
    kind: str,
    dedup_key: str,
    payload: dict[str, Any],
    *,
    now: datetime,
    run_at: datetime | None = None,
    max_attempts: int = 5,
) -> bool:
    """Returns True if a new job was created, False if dedup_key already existed."""
    ts = to_iso(now)
    cur = conn.execute(
        "INSERT OR IGNORE INTO jobs(id, kind, dedup_key, payload_json, state, run_at, "
        "max_attempts, created_at, updated_at) VALUES (?,?,?,?, 'pending', ?,?,?,?)",
        (
            new_id(),
            kind,
            dedup_key,
            json.dumps(payload, sort_keys=True),
            to_iso(run_at or now),
            max_attempts,
            ts,
            ts,
        ),
    )
    return cur.rowcount == 1


def lease(
    conn: sqlite3.Connection,
    owner: str,
    *,
    now: datetime,
    lease_for: timedelta = timedelta(minutes=5),
    kinds: tuple[str, ...] | None = None,
) -> Job | None:
    ts = to_iso(now)
    kind_filter = ""
    params: list[Any] = [owner, to_iso(now + lease_for), ts, ts, ts]
    if kinds:
        kind_filter = f" AND kind IN ({','.join('?' * len(kinds))})"
        params.extend(kinds)
    row = conn.execute(
        f"""
        UPDATE jobs SET state='leased', lease_owner=?, lease_until=?, attempts=attempts+1,
               updated_at=?
        WHERE id = (
            SELECT id FROM jobs
            WHERE ((state='pending' AND run_at <= ?) OR (state='leased' AND lease_until <= ?))
            {kind_filter}
            ORDER BY run_at LIMIT 1
        )
        RETURNING id, kind, dedup_key, payload_json, attempts, lease_owner
        """,
        params,
    ).fetchone()
    if row is None:
        return None
    return Job(
        row["id"],
        row["kind"],
        row["dedup_key"],
        json.loads(row["payload_json"]),
        row["attempts"],
        row["lease_owner"],
    )


def complete(conn: sqlite3.Connection, job: Job, *, now: datetime) -> bool:
    """Only the current lease holder can complete (stale workers are ignored)."""
    cur = conn.execute(
        "UPDATE jobs SET state='completed', lease_owner=NULL, lease_until=NULL, updated_at=? "
        "WHERE id=? AND state='leased' AND lease_owner=?",
        (to_iso(now), job.id, job.lease_owner),
    )
    return cur.rowcount == 1


def fail(
    conn: sqlite3.Connection,
    job: Job,
    error: str,
    *,
    now: datetime,
    retry_after: timedelta | None = None,
    manual: bool = False,
) -> str:
    """Record a failure. Returns the new state ('pending', 'failed' or 'manual')."""
    row = conn.execute(
        "SELECT attempts, max_attempts FROM jobs WHERE id=? AND state='leased' AND lease_owner=?",
        (job.id, job.lease_owner),
    ).fetchone()
    if row is None:
        return "stale"
    if manual:
        state, run_at = "manual", now
    elif row["attempts"] >= row["max_attempts"]:
        state, run_at = "failed", now
    else:
        backoff = retry_after or timedelta(seconds=min(3600, 2 ** row["attempts"] * 5))
        state, run_at = "pending", now + backoff
    conn.execute(
        "UPDATE jobs SET state=?, run_at=?, last_error=?, lease_owner=NULL, lease_until=NULL, "
        "updated_at=? WHERE id=?",
        (state, to_iso(run_at), error[:500], to_iso(now), job.id),
    )
    return state


def next_run_at(conn: sqlite3.Connection) -> datetime | None:
    row = conn.execute("SELECT MIN(run_at) FROM jobs WHERE state='pending'").fetchone()
    return from_iso(row[0]) if row and row[0] else None
