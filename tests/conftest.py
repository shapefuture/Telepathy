from __future__ import annotations

import itertools
import sqlite3
from collections.abc import Iterator
from typing import Any

import pytest

from telepathy.domain.types import Role, Visibility
from telepathy.ingest.normalize import normalize_message
from telepathy.ingest.service import enable_source, ingest
from telepathy.storage import acl, db

COMMUNITY = "c1"
OWNER_TG = 1000
_ids = itertools.count(1)


@pytest.fixture
def conn() -> Iterator[sqlite3.Connection]:
    c = db.connect(":memory:")
    db.migrate(c)
    db.ensure_community(c, COMMUNITY, "Test", "Asia/Jerusalem")
    yield c
    c.close()


@pytest.fixture
def owner(conn: sqlite3.Connection) -> str:
    mid = acl.upsert_member(conn, COMMUNITY, OWNER_TG)
    conn.execute("UPDATE members SET role=? WHERE id=?", (Role.OWNER.value, mid))
    return mid


def tg_message(
    chat_id: int,
    text: str,
    *,
    user_id: int = 42,
    message_id: int | None = None,
    date: int = 1_760_000_000,
    edit_date: int | None = None,
    **extra: Any,
) -> dict[str, Any]:
    m: dict[str, Any] = {
        "message_id": message_id if message_id is not None else next(_ids),
        "date": date,
        "chat": {"id": chat_id, "type": "supergroup", "title": "Group"},
        "from": {"id": user_id, "is_bot": False, "first_name": "Secret", "username": "secret_u"},
        "text": text,
    }
    if edit_date:
        m["edit_date"] = edit_date
    m.update(extra)
    return m


def enable(
    conn: sqlite3.Connection,
    owner: str,
    chat_id: int,
    vis: Visibility = Visibility.MEMBER_CONSENTED,
) -> str:
    return enable_source(conn, COMMUNITY, chat_id, visibility=vis, enabled_by_member_id=owner)


def post(conn: sqlite3.Connection, chat_id: int, text: str, **kw: Any):  # type: ignore[no-untyped-def]
    return ingest(conn, COMMUNITY, normalize_message(tg_message(chat_id, text, **kw)))


def ctx_for(conn: sqlite3.Connection, tg_id: int):  # type: ignore[no-untyped-def]
    return acl.access_context(conn, COMMUNITY, tg_id)
