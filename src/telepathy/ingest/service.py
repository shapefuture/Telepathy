"""Idempotent ingestion of normalized messages (P03-02, P03-03, P03-07, P03-08).

One transaction per event: raw event, member, message, excerpt, FTS row and checkpoint
commit together or not at all.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from enum import StrEnum

from telepathy.domain.text import normalize, sha256_hex
from telepathy.domain.types import Visibility, new_id, to_iso, utcnow
from telepathy.ingest.normalize import NormalizedMessage, citation_uri
from telepathy.storage import acl
from telepathy.storage.db import audit, transaction


class IngestOutcome(StrEnum):
    NOT_AUTHORIZED = "not_authorized"  # chat not enabled: nothing stored (C01)
    DUPLICATE = "duplicate"
    STORED = "stored"
    UPDATED = "updated"  # newer edit applied
    STALE_EDIT = "stale_edit"  # older revision arrived late; recorded, not applied


@dataclass(frozen=True, slots=True)
class Source:
    id: str
    community_id: str
    external_ref: str
    visibility: Visibility
    public_username: str | None


def get_enabled_source(
    conn: sqlite3.Connection, community_id: str, platform: str, chat_id: int
) -> Source | None:
    row = conn.execute(
        "SELECT id, community_id, external_ref, visibility, public_username FROM sources "
        "WHERE community_id=? AND platform=? AND external_ref=? AND enabled=1",
        (community_id, platform, str(chat_id)),
    ).fetchone()
    if row is None:
        return None
    return Source(
        row["id"],
        row["community_id"],
        row["external_ref"],
        Visibility(row["visibility"]),
        row["public_username"],
    )


def enable_source(
    conn: sqlite3.Connection,
    community_id: str,
    chat_id: int,
    *,
    visibility: Visibility,
    enabled_by_member_id: str,
    title: str | None = None,
    public_username: str | None = None,
    platform: str = "telegram",
) -> str:
    """Authorize a chat for collection. Caller must have verified the actor is an owner."""
    now = to_iso(utcnow())
    with transaction(conn):
        conn.execute(
            "INSERT INTO sources(id, community_id, platform, external_ref, title, public_username, "
            "visibility, enabled, enabled_by, enabled_at) VALUES (?,?,?,?,?,?,?,1,?,?) "
            "ON CONFLICT(community_id, platform, external_ref) DO UPDATE SET enabled=1, "
            "visibility=excluded.visibility, enabled_by=excluded.enabled_by, "
            "enabled_at=excluded.enabled_at, title=excluded.title, "
            "public_username=excluded.public_username, policy_version=policy_version+1",
            (
                new_id(),
                community_id,
                platform,
                str(chat_id),
                title,
                public_username,
                visibility.value,
                enabled_by_member_id,
                now,
            ),
        )
        sid = conn.execute(
            "SELECT id FROM sources WHERE community_id=? AND platform=? AND external_ref=?",
            (community_id, platform, str(chat_id)),
        ).fetchone()["id"]
        acl.grant_source_access(conn, sid, enabled_by_member_id, "admin")
        audit(
            conn,
            "source.enable",
            actor_member_id=enabled_by_member_id,
            subject=sid,
            detail_json=json.dumps({"visibility": visibility.value}),
        )
    return str(sid)


def disable_source(
    conn: sqlite3.Connection,
    community_id: str,
    chat_id: int,
    *,
    actor_member_id: str,
    platform: str = "telegram",
) -> bool:
    """Stop ingest; existing evidence is excluded from all results immediately via ACL."""
    with transaction(conn):
        cur = conn.execute(
            "UPDATE sources SET enabled=0, policy_version=policy_version+1 "
            "WHERE community_id=? AND platform=? AND external_ref=? AND enabled=1",
            (community_id, platform, str(chat_id)),
        )
        if cur.rowcount:
            audit(conn, "source.disable", actor_member_id=actor_member_id, subject=str(chat_id))
    return cur.rowcount == 1


def _add_excerpt(
    conn: sqlite3.Connection,
    src: Source,
    message_id: str,
    msg: NormalizedMessage,
    now: str,
    supersedes: str | None,
) -> None:
    excerpt_id = new_id()
    cur = conn.execute(
        "INSERT INTO excerpts(id, source_id, message_id, body, citation_uri, event_at, valid_from, "
        "supersedes_id, content_sha256) VALUES (?,?,?,?,?,?,?,?,?)",
        (
            excerpt_id,
            src.id,
            message_id,
            msg.text,
            citation_uri(msg.chat_id, msg.message_id, src.public_username, msg.topic_id),
            msg.event_at,
            now,
            supersedes,
            sha256_hex(msg.text),
        ),
    )
    conn.execute(
        "INSERT INTO excerpts_fts(rowid, body) VALUES (?, ?)", (cur.lastrowid, normalize(msg.text))
    )


def _retire_excerpts(conn: sqlite3.Connection, message_id: str, now: str) -> str | None:
    """Mark live excerpts of a message stale and drop their FTS/vector rows (C06)."""
    rows = conn.execute(
        "SELECT rowid, id FROM excerpts WHERE message_id=? AND valid_to IS NULL", (message_id,)
    ).fetchall()
    for r in rows:
        conn.execute("UPDATE excerpts SET valid_to=? WHERE id=?", (now, r["id"]))
        conn.execute("DELETE FROM excerpts_fts WHERE rowid=?", (r["rowid"],))
        conn.execute("DELETE FROM embeddings WHERE excerpt_id=?", (r["id"],))
    return rows[-1]["id"] if rows else None


def ingest(
    conn: sqlite3.Connection,
    community_id: str,
    msg: NormalizedMessage,
    *,
    update_id: int | None = None,
) -> IngestOutcome:
    src = get_enabled_source(conn, community_id, msg.platform, msg.chat_id)
    if src is None:
        return IngestOutcome.NOT_AUTHORIZED
    now = to_iso(utcnow())

    with transaction(conn):
        cur = conn.execute(
            "INSERT OR IGNORE INTO raw_events(id, source_id, dedup_key, observed_at, raw_json) "
            "VALUES (?,?,?,?,?)",
            (
                new_id(),
                src.id,
                msg.dedup_key,
                now,
                json.dumps(msg.minimized(), ensure_ascii=False, sort_keys=True),
            ),
        )
        if cur.rowcount == 0:
            return IngestOutcome.DUPLICATE

        author_id: str | None = None
        if msg.sender_tg_id is not None and not msg.sender_is_bot:
            author_id = acl.upsert_member(conn, community_id, msg.sender_tg_id)
            acl.grant_source_access(conn, src.id, author_id, "observed_post")

        existing = conn.execute(
            "SELECT id, edit_version, removed_at FROM messages "
            "WHERE source_id=? AND external_message_id=?",
            (src.id, str(msg.message_id)),
        ).fetchone()

        outcome: IngestOutcome
        if existing is None:
            message_id = new_id()
            conn.execute(
                "INSERT INTO messages(id, source_id, external_message_id, author_member_id, body, "
                "media_kind, media_file_id, event_at, observed_at, edited_at, edit_version, "
                "topic_id, reply_to_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    message_id,
                    src.id,
                    str(msg.message_id),
                    author_id,
                    msg.text,
                    msg.media_kind,
                    msg.media_file_id,
                    msg.event_at,
                    now,
                    msg.edited_at,
                    msg.edit_version,
                    str(msg.topic_id) if msg.topic_id else None,
                    str(msg.reply_to_message_id) if msg.reply_to_message_id else None,
                ),
            )
            if msg.text.strip():
                _add_excerpt(conn, src, message_id, msg, now, None)
            outcome = IngestOutcome.STORED
        elif existing["removed_at"] is not None or msg.edit_version <= existing["edit_version"]:
            outcome = IngestOutcome.STALE_EDIT
        else:
            message_id = existing["id"]
            conn.execute(
                "UPDATE messages SET body=?, edited_at=?, edit_version=?, revision=revision+1, "
                "media_kind=COALESCE(?, media_kind), media_file_id=COALESCE(?, media_file_id) "
                "WHERE id=?",
                (
                    msg.text,
                    msg.edited_at,
                    msg.edit_version,
                    msg.media_kind,
                    msg.media_file_id,
                    message_id,
                ),
            )
            prev = _retire_excerpts(conn, message_id, now)
            if msg.text.strip():
                _add_excerpt(conn, src, message_id, msg, now, prev)
            outcome = IngestOutcome.UPDATED

        conn.execute("UPDATE raw_events SET processed_at=? WHERE dedup_key=?", (now, msg.dedup_key))
        if update_id is not None:
            # P03-07: checkpoint advances only inside the committing transaction.
            conn.execute(
                "INSERT INTO sync_state(key, value, updated_at) "
                "VALUES ('telegram.last_update_id',?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
                "updated_at=excluded.updated_at "
                "WHERE CAST(excluded.value AS INTEGER) > CAST(sync_state.value AS INTEGER)",
                (str(update_id), now),
            )
    return outcome


def remove_message(
    conn: sqlite3.Connection,
    source_id: str,
    external_message_id: str,
    *,
    actor_member_id: str | None,
    reason: str,
) -> bool:
    """Deletion handling (P03-08 / P07-08): message body cleared, evidence revoked."""
    now = to_iso(utcnow())
    with transaction(conn):
        row = conn.execute(
            "SELECT id FROM messages WHERE source_id=? AND external_message_id=? "
            "AND removed_at IS NULL",
            (source_id, external_message_id),
        ).fetchone()
        if row is None:
            return False
        _retire_excerpts(conn, row["id"], now)
        conn.execute("UPDATE messages SET removed_at=?, body=NULL WHERE id=?", (now, row["id"]))
        # Raw events carry the text too; keep the dedup key, drop the content.
        conn.execute(
            "UPDATE raw_events SET raw_json='{\"removed\": true}' WHERE source_id=? "
            "AND dedup_key LIKE (SELECT platform || ':' || external_ref FROM sources WHERE id=?) "
            "|| ':' || ? || ':%'",
            (source_id, source_id, external_message_id),
        )
        audit(
            conn,
            "message.remove",
            actor_member_id=actor_member_id,
            subject=row["id"],
            detail_json=json.dumps({"reason": reason}),
        )
    return True
