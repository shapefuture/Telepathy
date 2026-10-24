from __future__ import annotations

import json

from conftest import COMMUNITY, enable, post, tg_message

from telepathy.ingest.normalize import citation_uri, normalize_message
from telepathy.ingest.service import IngestOutcome, ingest, remove_message


def test_unlisted_chat_stores_nothing(conn):
    assert post(conn, -1001, "hello") is IngestOutcome.NOT_AUTHORIZED
    for table in ("raw_events", "messages", "excerpts", "members"):
        assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0


def test_duplicate_replay_is_idempotent(conn, owner):
    enable(conn, owner, -1001)
    raw = tg_message(-1001, "where is the meetup?", message_id=7)
    nm = normalize_message(raw)
    assert ingest(conn, COMMUNITY, nm) is IngestOutcome.STORED
    for _ in range(5):
        assert ingest(conn, COMMUNITY, nm) is IngestOutcome.DUPLICATE
    assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM excerpts").fetchone()[0] == 1


def test_out_of_order_edits_converge(conn, owner):
    enable(conn, owner, -1001)
    v0 = normalize_message(tg_message(-1001, "original", message_id=9))
    v1 = normalize_message(tg_message(-1001, "first edit", message_id=9, edit_date=1_760_000_100))
    v2 = normalize_message(tg_message(-1001, "second edit", message_id=9, edit_date=1_760_000_200))
    # Arrives as v2, v0, v1: final state must be v2.
    assert ingest(conn, COMMUNITY, v2) is IngestOutcome.STORED
    assert ingest(conn, COMMUNITY, v0) is IngestOutcome.STALE_EDIT
    assert ingest(conn, COMMUNITY, v1) is IngestOutcome.STALE_EDIT
    body = conn.execute("SELECT body FROM messages").fetchone()[0]
    assert body == "second edit"
    live = conn.execute("SELECT body FROM excerpts WHERE valid_to IS NULL").fetchall()
    assert [r[0] for r in live] == ["second edit"]


def test_edit_supersedes_excerpt_and_fts(conn, owner):
    enable(conn, owner, -1001)
    post(conn, -1001, "accountant is Bob", message_id=3)
    post(conn, -1001, "accountant is Alice", message_id=3, edit_date=1_760_000_500)
    live = conn.execute("SELECT body FROM excerpts WHERE valid_to IS NULL").fetchall()
    assert [r[0] for r in live] == ["accountant is Alice"]
    fts = conn.execute("SELECT body FROM excerpts_fts").fetchall()
    assert [r[0] for r in fts] == ["accountant is alice"]


def test_raw_event_is_minimized(conn, owner):
    enable(conn, owner, -1001)
    post(conn, -1001, "hi there", user_id=55)
    raw = conn.execute("SELECT raw_json FROM raw_events").fetchone()[0]
    assert "Secret" not in raw and "secret_u" not in raw
    assert json.loads(raw)["sender_tg_id"] == 55


def test_media_stores_file_id_only(conn, owner):
    enable(conn, owner, -1001)
    msg = tg_message(-1001, "", photo=[{"file_id": "small"}, {"file_id": "big"}])
    del msg["text"]
    msg["caption"] = "slides from the talk"
    ingest(conn, COMMUNITY, normalize_message(msg))
    row = conn.execute("SELECT media_kind, media_file_id, body FROM messages").fetchone()
    assert tuple(row) == ("photo", "big", "slides from the talk")


def test_remove_message_revokes_evidence(conn, owner):
    sid = enable(conn, owner, -1001)
    post(conn, -1001, "delete me please", message_id=11)
    assert remove_message(conn, sid, "11", actor_member_id=owner, reason="user_request")
    assert conn.execute("SELECT COUNT(*) FROM excerpts WHERE valid_to IS NULL").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM excerpts_fts").fetchone()[0] == 0
    assert conn.execute("SELECT body FROM messages").fetchone()[0] is None
    assert "delete me" not in conn.execute("SELECT raw_json FROM raw_events").fetchone()[0]


def test_checkpoint_only_moves_forward(conn, owner):
    enable(conn, owner, -1001)
    ingest(conn, COMMUNITY, normalize_message(tg_message(-1001, "a")), update_id=10)
    ingest(conn, COMMUNITY, normalize_message(tg_message(-1001, "b")), update_id=8)
    v = conn.execute("SELECT value FROM sync_state WHERE key='telegram.last_update_id'").fetchone()
    assert v[0] == "10"


def test_citation_links():
    assert citation_uri(-1001234, 5, None) == "https://t.me/c/1234/5"
    assert citation_uri(-1001234, 5, None, topic_id=2) == "https://t.me/c/1234/2/5"
    assert citation_uri(-1001234, 5, "pubgroup") == "https://t.me/pubgroup/5"
    assert citation_uri(-55, 5, None) is None
