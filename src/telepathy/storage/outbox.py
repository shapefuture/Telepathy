"""Effect outbox for external sends (P02-08, P09-06, C09).

Telegram delivery cannot be exactly-once. We guarantee *at-most-once from normal retry
flow*: an intent is marked 'dispatching' before the network call. If the process dies
or the call outcome is unknown, the intent becomes 'uncertain' and is never resent
automatically; an operator or reconciler resolves it.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any

from telepathy.domain.types import new_id, to_iso


class DefiniteFailure(Exception):
    """The provider definitely did not deliver (e.g. HTTP 400/403). Safe to mark failed."""


def create_intent(
    conn: sqlite3.Connection,
    kind: str,
    target: str,
    payload: dict[str, Any],
    idempotency_key: str,
    *,
    now: datetime,
) -> str:
    """Create or return the existing intent for idempotency_key."""
    body = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    ts = to_iso(now)
    conn.execute(
        "INSERT OR IGNORE INTO effect_intents(id, idempotency_key, kind, target, payload_json, "
        "payload_hash, state, created_at, updated_at) VALUES (?,?,?,?,?,?, 'pending', ?, ?)",
        (
            new_id(),
            idempotency_key,
            kind,
            target,
            body,
            hashlib.sha256(body.encode()).hexdigest(),
            ts,
            ts,
        ),
    )
    row = conn.execute(
        "SELECT id FROM effect_intents WHERE idempotency_key=?", (idempotency_key,)
    ).fetchone()
    return str(row["id"])


def state_of(conn: sqlite3.Connection, effect_id: str) -> str:
    row = conn.execute("SELECT state FROM effect_intents WHERE id=?", (effect_id,)).fetchone()
    if row is None:
        raise KeyError(effect_id)
    return str(row["state"])


def _set(
    conn: sqlite3.Connection,
    effect_id: str,
    frm: str,
    to: str,
    now: datetime,
    ref: str | None = None,
    error: str | None = None,
) -> bool:
    resolved = to_iso(now) if to in ("sent", "reconciled", "failed") else None
    cur = conn.execute(
        "UPDATE effect_intents SET state=?, updated_at=?, resolved_at=COALESCE(?, resolved_at), "
        "provider_response_ref=COALESCE(?, provider_response_ref), "
        "last_error=COALESCE(?, last_error) "
        "WHERE id=? AND state=?",
        (to, to_iso(now), resolved, ref, error, effect_id, frm),
    )
    return cur.rowcount == 1


async def dispatch(
    conn: sqlite3.Connection,
    effect_id: str,
    send: Callable[[str, dict[str, Any]], Awaitable[str]],
    *,
    now: Callable[[], datetime],
) -> str:
    """Send one pending intent. Returns the resulting state."""
    row = conn.execute(
        "SELECT target, payload_json FROM effect_intents WHERE id=?", (effect_id,)
    ).fetchone()
    if row is None:
        raise KeyError(effect_id)
    # Claim: only one dispatcher can move pending -> dispatching.
    if not _set(conn, effect_id, "pending", "dispatching", now()):
        return state_of(conn, effect_id)
    try:
        ref = await send(row["target"], json.loads(row["payload_json"]))
    except DefiniteFailure as exc:
        _set(conn, effect_id, "dispatching", "failed", now(), error=str(exc))
        return "failed"
    except (asyncio.CancelledError, Exception) as exc:
        # Timeout, connection reset, cancellation: we do not know if Telegram delivered.
        _set(conn, effect_id, "dispatching", "uncertain", now(), error=repr(exc))
        if isinstance(exc, asyncio.CancelledError):
            raise
        return "uncertain"
    _set(conn, effect_id, "dispatching", "sent", now(), ref=ref)
    return "sent"


def recover_after_crash(conn: sqlite3.Connection, *, now: datetime) -> int:
    """On startup: any intent left 'dispatching' has unknown outcome -> 'uncertain'."""
    cur = conn.execute(
        "UPDATE effect_intents SET state='uncertain', updated_at=?, "
        "last_error='process restarted during dispatch' WHERE state='dispatching'",
        (to_iso(now),),
    )
    return cur.rowcount


def reconcile(
    conn: sqlite3.Connection, effect_id: str, *, delivered: bool, now: datetime, note: str
) -> bool:
    """Operator/reconciler decision for an uncertain intent. Never triggers a resend itself."""
    to = "reconciled" if delivered else "failed"
    return _set(conn, effect_id, "uncertain", to, now, error=note)
