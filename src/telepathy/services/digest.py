"""Daily digest (P10-01..P10-09).

Deterministic and extractive: counts, open questions and new documents with links. No
narrative is generated. Each recipient's digest is built from *their own* readable
sources (C02). Members opt in with /digest on (K14). The window checkpoint advances only
after every send is accepted (P10-08).
"""

from __future__ import annotations

import html
import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from telepathy.domain.text import snippet
from telepathy.domain.types import from_iso, to_iso
from telepathy.storage import acl
from telepathy.storage.db import audit

MAX_ITEMS = 5
CHECKPOINT_KEY = "digest.last_window_end"
HELP_INTENT_MIN = 0.55


def fire_time_utc(local_day: date, at: time, tz: ZoneInfo) -> datetime:
    """09:00 local on that day, converted to UTC (handles DST via zoneinfo)."""
    return datetime.combine(local_day, at, tzinfo=tz).astimezone(UTC)


def due_local_day(now: datetime, at: time, tz: ZoneInfo) -> date | None:
    """The local date whose digest is due at `now`, or None if today's time hasn't come."""
    today = now.astimezone(tz).date()
    return today if now >= fire_time_utc(today, at, tz) else None


def window_start(conn: sqlite3.Connection, window_end: datetime) -> datetime:
    row = conn.execute("SELECT value FROM sync_state WHERE key=?", (CHECKPOINT_KEY,)).fetchone()
    start = from_iso(row[0]) if row else window_end - timedelta(days=1)
    # Never look back more than 7 days, even after a long outage.
    return max(start, window_end - timedelta(days=7))


def advance_checkpoint(conn: sqlite3.Connection, window_end: datetime) -> None:
    conn.execute(
        "INSERT INTO sync_state(key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) "
        "DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        (CHECKPOINT_KEY, to_iso(window_end), to_iso(window_end)),
    )


@dataclass(frozen=True, slots=True)
class Recipient:
    member_id: str
    telegram_user_id: int


def recipients(conn: sqlite3.Connection, community_id: str) -> list[Recipient]:
    """Every active member who opted in with /digest on (K14). Content is ACL-scoped per person."""
    rows = conn.execute(
        "SELECT id, telegram_user_id FROM members WHERE community_id=? AND removed_at IS NULL "
        "AND digest_opt_in=1 AND collection_opt_out=0 AND telegram_user_id IS NOT NULL",
        (community_id,),
    ).fetchall()
    return [Recipient(r["id"], int(r["telegram_user_id"])) for r in rows]


def set_opt_in(conn: sqlite3.Connection, member_id: str, on: bool) -> None:
    conn.execute("UPDATE members SET digest_opt_in=? WHERE id=?", (int(on), member_id))


def build(
    conn: sqlite3.Connection,
    community_id: str,
    member_id: str,
    start: datetime,
    end: datetime,
    tz: ZoneInfo,
) -> str | None:
    """Digest HTML for one recipient, or None if nothing happened in their sources."""
    readable = acl.readable_source_ids(conn, community_id, member_id)
    if not readable:
        return None
    src_json = json.dumps(sorted(readable))
    a, b = to_iso(start), to_iso(end)
    per_source = conn.execute(
        """
        SELECT s.title, COUNT(*) AS n FROM messages m JOIN sources s ON s.id = m.source_id
        WHERE m.source_id IN (SELECT value FROM json_each(?)) AND m.removed_at IS NULL
          AND m.event_at >= ? AND m.event_at < ?
        GROUP BY s.id ORDER BY n DESC
        """,
        (src_json, a, b),
    ).fetchall()
    if not per_source:
        return None
    questions = conn.execute(
        """
        SELECT m.body, e.citation_uri,
               (SELECT COUNT(*) FROM messages r WHERE r.source_id = m.source_id
                  AND r.reply_to_id = m.external_message_id AND r.removed_at IS NULL) AS replies
        FROM messages m
        LEFT JOIN excerpts e ON e.message_id = m.id AND e.valid_to IS NULL
                             AND e.document_id IS NULL
        WHERE m.source_id IN (SELECT value FROM json_each(?)) AND m.removed_at IS NULL
          AND m.event_at >= ? AND m.event_at < ?
          AND m.intent = 'help_request' AND m.intent_confidence >= ?
        ORDER BY replies ASC, m.event_at DESC
        """,
        (src_json, a, b, HELP_INTENT_MIN),
    ).fetchall()
    docs = conn.execute(
        """
        SELECT d.title, d.status, e.citation_uri FROM documents d
        LEFT JOIN excerpts e ON e.document_id = d.id AND e.valid_to IS NULL
        WHERE d.source_id IN (SELECT value FROM json_each(?)) AND d.removed_at IS NULL
          AND d.created_at >= ? AND d.created_at < ?
        GROUP BY d.id ORDER BY d.created_at DESC LIMIT ?
        """,
        (src_json, a, b, MAX_ITEMS),
    ).fetchall()

    def link(uri: str | None, label: str) -> str:
        return f'<a href="{html.escape(uri, quote=True)}">{label}</a>' if uri else label

    day = end.astimezone(tz).strftime("%Y-%m-%d")
    total = sum(r["n"] for r in per_source)
    lines = [f"<b>Daily digest · {day}</b>", f"{total} new message(s):"]
    lines += [f"• {html.escape(r['title'] or 'Untitled group')}: {r['n']}" for r in per_source[:10]]
    if len(per_source) > 10:
        lines.append(f"• …and {len(per_source) - 10} more group(s)")
    unanswered = [q for q in questions if q["replies"] == 0]
    answered = [q for q in questions if q["replies"] > 0]
    if unanswered:
        lines.append(f"\n<b>Open questions ({len(unanswered)})</b>")
        for q in unanswered[:MAX_ITEMS]:
            lines.append(
                f"• {html.escape(snippet(q['body'] or '', [], 160))} "
                f"({link(q['citation_uri'], 'open')})"
            )
    if answered:
        lines.append(f"\n<b>Answered questions ({len(answered)})</b>")
        for q in answered[:MAX_ITEMS]:
            lines.append(
                f"• {html.escape(snippet(q['body'] or '', [], 120))} "
                f"— {q['replies']} repl{'y' if q['replies'] == 1 else 'ies'} "
                f"({link(q['citation_uri'], 'thread')})"
            )
    if docs:
        lines.append("\n<b>New documents</b>")
        for d in docs:
            note = "" if d["status"] == "parsed" else f" ({d['status']})"
            lines.append(f"• {link(d['citation_uri'], html.escape(d['title'] or 'file'))}{note}")
    lines.append("\n<i>Quotes are verbatim; follow links for context. Turn off: /digest off</i>")
    return "\n".join(lines)


def record(conn: sqlite3.Connection, local_day: date, sent: int) -> None:
    audit(
        conn,
        "digest.sent",
        subject=local_day.isoformat(),
        detail_json=json.dumps({"recipients": sent}),
    )
