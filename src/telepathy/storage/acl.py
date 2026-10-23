"""Access control: the single place that decides which sources a member may read.

Deny by default (C01, C02, C06). Retrieval, citations, digests and model submission all
take their source set from `readable_source_ids` and nowhere else.

Rules:
  * member must exist in the community and not be removed
  * source must belong to the same community and be enabled
  * PRIVATE_UNKNOWN          -> nobody
  * PUBLIC_APPROVED          -> any active community member
  * MEMBER_CONSENTED         -> members with an active source_access grant
  * INTERNAL_RESTRICTED      -> active grant AND role >= moderator
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from telepathy.domain.types import AccessContext, Role, Visibility, new_id, to_iso, utcnow


@dataclass(frozen=True, slots=True)
class Member:
    id: str
    community_id: str
    role: Role
    removed: bool


def get_member_by_telegram(
    conn: sqlite3.Connection, community_id: str, telegram_user_id: int
) -> Member | None:
    row = conn.execute(
        "SELECT id, community_id, role, removed_at FROM members "
        "WHERE community_id=? AND telegram_user_id=?",
        (community_id, str(telegram_user_id)),
    ).fetchone()
    if row is None:
        return None
    return Member(row["id"], row["community_id"], Role(row["role"]), row["removed_at"] is not None)


def upsert_member(conn: sqlite3.Connection, community_id: str, telegram_user_id: int) -> str:
    """Return the pseudonymous member id, creating a private, non-discoverable row if new."""
    existing = get_member_by_telegram(conn, community_id, telegram_user_id)
    if existing:
        return existing.id
    member_id = new_id()
    conn.execute(
        "INSERT INTO members(id, community_id, telegram_user_id, created_at) VALUES (?,?,?,?)",
        (member_id, community_id, str(telegram_user_id), to_iso(utcnow())),
    )
    return member_id


def grant_source_access(
    conn: sqlite3.Connection, source_id: str, member_id: str, reason: str
) -> None:
    """Grant (or re-grant after revocation) read access to a source."""
    conn.execute(
        "INSERT INTO source_access(source_id, member_id, granted_at, grant_reason) "
        "VALUES (?,?,?,?) ON CONFLICT(source_id, member_id) DO UPDATE SET "
        "revoked_at=NULL, granted_at=excluded.granted_at, grant_reason=excluded.grant_reason "
        "WHERE source_access.revoked_at IS NOT NULL",
        (source_id, member_id, to_iso(utcnow()), reason),
    )


def revoke_source_access(conn: sqlite3.Connection, source_id: str, member_id: str) -> None:
    conn.execute(
        "UPDATE source_access SET revoked_at=? WHERE source_id=? AND member_id=? "
        "AND revoked_at IS NULL",
        (to_iso(utcnow()), source_id, member_id),
    )


def readable_source_ids(
    conn: sqlite3.Connection, community_id: str, member_id: str
) -> frozenset[str]:
    m = conn.execute(
        "SELECT role FROM members WHERE id=? AND community_id=? AND removed_at IS NULL",
        (member_id, community_id),
    ).fetchone()
    if m is None:
        return frozenset()
    is_staff = Role(m["role"]).at_least(Role.MODERATOR)
    rows = conn.execute(
        """
        SELECT s.id, s.visibility,
               EXISTS(SELECT 1 FROM source_access a
                      WHERE a.source_id = s.id AND a.member_id = ? AND a.revoked_at IS NULL)
                 AS granted
        FROM sources s
        WHERE s.community_id = ? AND s.enabled = 1
        """,
        (member_id, community_id),
    ).fetchall()
    allowed: set[str] = set()
    for r in rows:
        vis = Visibility(r["visibility"])
        if (
            vis is Visibility.PUBLIC_APPROVED
            or (vis is Visibility.MEMBER_CONSENTED and r["granted"])
            or (vis is Visibility.INTERNAL_RESTRICTED and r["granted"] and is_staff)
        ):
            allowed.add(r["id"])
    return frozenset(allowed)


def access_context(
    conn: sqlite3.Connection, community_id: str, telegram_user_id: int
) -> AccessContext | None:
    """Resolve a verified Telegram identity into an AccessContext (P06-01)."""
    m = get_member_by_telegram(conn, community_id, telegram_user_id)
    if m is None or m.removed:
        return None
    return AccessContext(
        community_id=community_id,
        member_id=m.id,
        role=m.role,
        readable_source_ids=readable_source_ids(conn, community_id, m.id),
    )
