"""Data rights and retention (P08-09, P11-07, C06, C13).

forget_member: deletes everything derived from a member and stops future collection
of their messages. Retention purges evidence older than each source's limit.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta

from telepathy.domain.types import to_iso
from telepathy.ingest.service import purge_message_row
from telepathy.storage.db import audit, transaction


@dataclass(frozen=True, slots=True)
class ForgetReport:
    messages: int
    skills: int
    intros_cancelled: int


def forget_member(conn: sqlite3.Connection, member_id: str, now: datetime) -> ForgetReport:
    ts = to_iso(now)
    with transaction(conn):
        msg_ids = [
            r[0]
            for r in conn.execute(
                "SELECT id FROM messages WHERE author_member_id=? AND removed_at IS NULL",
                (member_id,),
            )
        ]
        for mid in msg_ids:
            purge_message_row(conn, mid, ts)
        skills = conn.execute("DELETE FROM skill_claims WHERE member_id=?", (member_id,)).rowcount
        conn.execute("DELETE FROM offers WHERE member_id=?", (member_id,))
        conn.execute(
            "UPDATE consent SET granted=0, revoked_at=? WHERE member_id=? AND granted=1",
            (ts, member_id),
        )
        intros = conn.execute(
            "UPDATE introductions SET status='cancelled', updated_at=? WHERE "
            "(requester_id=? OR candidate_id=?) AND status NOT IN "
            "('completed','declined','expired','cancelled')",
            (ts, member_id, member_id),
        ).rowcount
        conn.execute(
            "UPDATE needs SET status='cancelled', description='[removed]' WHERE member_id=?",
            (member_id,),
        )
        # Undelivered messages addressed to or about this member are withdrawn.
        tg = conn.execute(
            "SELECT telegram_user_id FROM members WHERE id=?", (member_id,)
        ).fetchone()
        if tg and tg[0]:
            conn.execute(
                "UPDATE effect_intents SET state='failed', last_error='member forgotten', "
                "resolved_at=? WHERE state='pending' AND target=?",
                (ts, f"tg:{tg[0]}"),
            )
        conn.execute(
            "UPDATE members SET discovery_opt_in=0, collection_opt_out=1, available=0, "
            "profile_visibility='private' WHERE id=?",
            (member_id,),
        )
        audit(
            conn,
            "member.forget",
            actor_member_id=member_id,
            subject=member_id,
            detail_json=json.dumps({"messages": len(msg_ids), "skills": skills, "intros": intros}),
        )
    return ForgetReport(len(msg_ids), skills, intros)


def resume_collection(conn: sqlite3.Connection, member_id: str) -> None:
    conn.execute("UPDATE members SET collection_opt_out=0 WHERE id=?", (member_id,))
    audit(conn, "member.resume_collection", actor_member_id=member_id, subject=member_id)


def apply_retention(conn: sqlite3.Connection, now: datetime, *, batch: int = 500) -> int:
    """Purge messages older than their source's retention_days. Returns count purged."""
    total = 0
    sources = conn.execute("SELECT id, retention_days FROM sources").fetchall()
    ts = to_iso(now)
    for s in sources:
        cutoff = to_iso(now - timedelta(days=int(s["retention_days"])))
        while True:
            with transaction(conn):
                ids = [
                    r[0]
                    for r in conn.execute(
                        "SELECT id FROM messages WHERE source_id=? AND removed_at IS NULL "
                        "AND event_at < ? LIMIT ?",
                        (s["id"], cutoff, batch),
                    )
                ]
                for mid in ids:
                    purge_message_row(conn, mid, ts)
            total += len(ids)
            if len(ids) < batch:
                break
    if total:
        audit(conn, "retention.purge", detail_json=json.dumps({"messages": total}))
    return total
