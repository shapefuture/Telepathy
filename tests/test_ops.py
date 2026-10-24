"""Digest scheduling/content, data rights, retention, backup, importer, worker."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from conftest import COMMUNITY, ctx_for, enable, post

from telepathy.config import Settings
from telepathy.domain.translit import lat_to_ru, ru_to_lat
from telepathy.ingest.importer import bot_api_chat_id, import_export
from telepathy.ingest.service import IngestOutcome
from telepathy.ops.backup import backup, verify
from telepathy.retrieval.answer import AnswerStatus, answer
from telepathy.services import data_rights, digest
from telepathy.storage import acl, experts, jobs
from telepathy.storage.outbox import DefiniteFailure
from telepathy.worker import Worker

TZ = ZoneInfo("Asia/Jerusalem")


def settings(tmp_path: Path, **kw) -> Settings:
    base = dict(
        bot_token="x",
        db_path=tmp_path / "t.db",
        owner_telegram_ids=frozenset({1000}),
        community_id=COMMUNITY,
        community_label="T",
        timezone=TZ,
        backup_dir=tmp_path / "backups",
    )
    base.update(kw)
    return Settings(**base)


# ---- digest -------------------------------------------------------------------------------


def test_fire_time_respects_dst():
    # Israel: UTC+3 in summer, UTC+2 in winter (DST ends 2026-10-25).
    assert digest.fire_time_utc(date(2026, 10, 24), time(9), TZ).hour == 6
    assert digest.fire_time_utc(date(2026, 10, 26), time(9), TZ).hour == 7
    # Spring forward 2026-03-27.
    assert digest.fire_time_utc(date(2026, 3, 26), time(9), TZ).hour == 7
    assert digest.fire_time_utc(date(2026, 3, 28), time(9), TZ).hour == 6


def test_due_local_day():
    before = datetime(2026, 10, 24, 5, 59, tzinfo=UTC)
    after = datetime(2026, 10, 24, 6, 0, tzinfo=UTC)
    assert digest.due_local_day(before, time(9), TZ) is None
    assert digest.due_local_day(after, time(9), TZ) == date(2026, 10, 24)


def test_digest_content_is_acl_scoped(conn, owner):
    enable(conn, owner, -1001234)
    enable(conn, owner, -1009)  # owner has access via enable grant
    now = datetime.now(UTC)
    post(
        conn,
        -1001234,
        "Can anyone recommend a dentist?",
        user_id=1,
        message_id=1,
        date=int(now.timestamp()) - 60,
    )
    post(
        conn,
        -1009,
        "Can anyone recommend a lawyer?",
        user_id=2,
        message_id=2,
        date=int(now.timestamp()) - 60,
    )
    text = digest.build(conn, COMMUNITY, owner, now - timedelta(days=1), now, TZ)
    assert "dentist" in text and "lawyer" in text and "Open questions (2)" in text
    # A member who can read only one group sees only that group.
    conn.execute("UPDATE members SET role='admin' WHERE telegram_user_id='1'")
    m1 = acl.get_member_by_telegram(conn, COMMUNITY, 1).id
    text1 = digest.build(conn, COMMUNITY, m1, now - timedelta(days=1), now, TZ)
    assert "dentist" in text1 and "lawyer" not in text1


def test_digest_empty_window_returns_none(conn, owner):
    enable(conn, owner, -1001)
    now = datetime.now(UTC)
    assert digest.build(conn, COMMUNITY, owner, now - timedelta(days=1), now, TZ) is None


# ---- data rights & retention --------------------------------------------------------------


def test_forget_member_removes_everything_and_stops_collection(conn, owner):
    enable(conn, owner, -1001)
    post(conn, -1001, "my secret plan about the venue", user_id=7)
    post(conn, -1001, "public answer about the venue", user_id=8)
    m7 = acl.get_member_by_telegram(conn, COMMUNITY, 7).id
    experts.set_discovery(conn, m7, True, datetime.now(UTC))
    experts.add_skill(conn, m7, "python", datetime.now(UTC))
    rep = data_rights.forget_member(conn, m7, datetime.now(UTC))
    assert rep.messages == 1 and rep.skills == 1
    hits = answer(conn, ctx_for(conn, 8), "venue plan")
    assert all("secret" not in q.text for q in hits.quotes)
    assert "secret" not in "".join(r[0] for r in conn.execute("SELECT raw_json FROM raw_events"))
    assert post(conn, -1001, "new message after forget", user_id=7) is IngestOutcome.OPTED_OUT
    assert experts.get_profile(conn, m7).discoverable is False
    data_rights.resume_collection(conn, m7)
    assert post(conn, -1001, "back again", user_id=7) is IngestOutcome.STORED


def test_retention_purges_old_messages(conn, owner):
    sid = enable(conn, owner, -1001)
    conn.execute("UPDATE sources SET retention_days=30 WHERE id=?", (sid,))
    now = datetime.now(UTC)
    post(
        conn,
        -1001,
        "ancient venue info",
        user_id=1,
        date=int((now - timedelta(days=40)).timestamp()),
    )
    post(conn, -1001, "fresh venue info", user_id=1, date=int(now.timestamp()))
    assert data_rights.apply_retention(conn, now) == 1
    ans = answer(conn, ctx_for(conn, 1), "venue info")
    assert [q.text for q in ans.quotes] == ["fresh venue info"]


# ---- backup -------------------------------------------------------------------------------


def test_backup_verify_and_prune(tmp_path, owner, conn):
    enable(conn, owner, -1001)
    post(conn, -1001, "backup me", user_id=1)
    for i in range(3):
        res = backup(conn, tmp_path, datetime(2026, 1, 1, 0, 0, i, tzinfo=UTC), keep=2)
        assert res.integrity == "ok"
    files = sorted(tmp_path.glob("telepathy-*.db"))
    assert len(files) == 2
    assert verify(files[-1]) == "ok"
    sha = files[-1].with_suffix(".db.sha256").read_text().split()[0]
    assert sha == res.sha256
    (tmp_path / "bad.db").write_bytes(b"garbage")
    assert verify(tmp_path / "bad.db") != "ok"


# ---- importer -----------------------------------------------------------------------------


def test_import_desktop_export(tmp_path, conn, owner):
    enable(conn, owner, -1001234)
    export = {
        "name": "G",
        "type": "private_supergroup",
        "id": 1234,
        "messages": [
            {
                "id": 1,
                "type": "message",
                "date": "2026-01-01T10:00:00",
                "date_unixtime": "1767261600",
                "from": "Alice",
                "from_id": "user5",
                "text": "Our accountant is Dana",
            },
            {
                "id": 2,
                "type": "message",
                "date_unixtime": "1767261700",
                "from_id": "user6",
                "text": ["see ", {"type": "link", "text": "https://example.org"}],
                "reply_to_message_id": 1,
            },
            {"id": 3, "type": "service", "action": "join_group"},
            {
                "id": 4,
                "type": "message",
                "date_unixtime": "1767261800",
                "photo": "x.jpg",
                "text": "",
            },
        ],
    }
    p = tmp_path / "result.json"
    p.write_text(json.dumps(export))
    assert bot_api_chat_id(export) == -1001234
    rep = import_export(conn, COMMUNITY, p)
    assert rep.seen == 2 and rep.outcomes == {"stored": 2}
    assert import_export(conn, COMMUNITY, p).outcomes == {"duplicate": 2}
    assert "Alice" not in "".join(r[0] for r in conn.execute("SELECT raw_json FROM raw_events"))
    assert answer(conn, ctx_for(conn, 5), "who is the accountant").status is AnswerStatus.ANSWERED


def test_import_refuses_unenabled_chat(tmp_path, conn):
    p = tmp_path / "result.json"
    p.write_text(json.dumps({"id": 99, "type": "private_supergroup", "messages": []}))
    with pytest.raises(PermissionError):
        import_export(conn, COMMUNITY, p)


# ---- translit -----------------------------------------------------------------------------


def test_translit_roundtrip_examples():
    assert ru_to_lat("деплой") == "deploy"
    assert lat_to_ru("zoom") == "зум"


def test_mixed_script_search(conn, owner):
    enable(conn, owner, -1001)
    post(conn, -1001, "Сделали деплой на прод вчера", user_id=1)
    ans = answer(conn, ctx_for(conn, 1), "deploy prod")
    assert ans.status is AnswerStatus.ANSWERED


# ---- worker -------------------------------------------------------------------------------


def test_worker_digest_checkpoint_only_after_delivery(tmp_path, conn, owner):
    enable(conn, owner, -1001)
    conn.execute("UPDATE members SET digest_opt_in=1 WHERE id=?", (owner,))  # K14: opt-in
    now = datetime.now(UTC)
    post(conn, -1001, "Can anyone recommend a plumber?", user_id=1, date=int(now.timestamp()) - 30)
    sent = []
    fail = {"on": True}

    async def send(target, payload):
        if fail["on"]:
            raise TimeoutError("network")
        sent.append(target)
        return "1"

    async def fetch(file_id):
        return b""

    w = Worker(conn, settings(tmp_path), send, fetch, clock=lambda: now)
    jobs.enqueue(conn, "digest", "digest:c1:manual", {}, now=now)
    asyncio.run(w.tick())
    # Unknown delivery outcome -> 'uncertain'. The operator reconciles it via /uncertain.
    st = conn.execute("SELECT state FROM effect_intents").fetchone()[0]
    assert st == "uncertain"
    fail["on"] = False
    asyncio.run(w.tick())
    assert sent == []  # uncertain sends are never retried automatically


def test_worker_schedules_daily_jobs_once(tmp_path, conn, owner):
    now = datetime(2026, 10, 24, 12, 0, tzinfo=UTC)

    async def send(target, payload):
        raise DefiniteFailure("blocked")

    async def fetch(file_id):
        return b""

    w = Worker(conn, settings(tmp_path), send, fetch, clock=lambda: now)
    asyncio.run(w.tick())
    asyncio.run(w.tick())
    kinds = sorted(r[0] for r in conn.execute("SELECT kind FROM jobs"))
    assert kinds == ["backup", "digest", "retention"]
    assert all(r[0] == "completed" for r in conn.execute("SELECT state FROM jobs"))
    assert list(Path(tmp_path / "backups").glob("telepathy-*.db"))


def test_worker_document_job(tmp_path, conn, owner):
    from telepathy.ingest.service import message_row_id

    sid = enable(conn, owner, -1001)
    now = datetime.now(UTC)
    # Recent message: the worker also runs retention, which would purge an old one.
    post(conn, -1001, "notes", user_id=1, message_id=9, date=int(now.timestamp()))
    row = message_row_id(conn, sid, "9")

    async def send(target, payload):
        return "1"

    async def fetch(file_id):
        assert file_id == "F1"
        return b"the gate code is 4321"

    w = Worker(conn, settings(tmp_path), send, fetch, clock=lambda: now)
    jobs.enqueue(
        conn,
        "doc.ingest",
        f"doc:{row}",
        {
            "source_id": sid,
            "message_row_id": row,
            "file_id": "F1",
            "file_name": "info.txt",
            "event_at": "2026-10-01T00:00:00+00:00",
            "citation_uri": None,
        },
        now=now,
    )
    asyncio.run(w.tick())
    assert answer(conn, ctx_for(conn, 1), "gate code").status is AnswerStatus.ANSWERED


def test_full_history_kept_by_default(conn, owner):
    """K15: no retention cap unless an owner sets one."""
    from telepathy.config import Settings as S

    assert (
        S(
            bot_token="x",
            db_path=".",
            owner_telegram_ids=frozenset({1}),
            community_id="c",
            community_label="c",
            timezone=TZ,
        ).retention_days
        == 0
    )
    sid = enable(conn, owner, -1001)
    assert conn.execute("SELECT retention_days FROM sources WHERE id=?", (sid,)).fetchone()[0] == 0
    now = datetime.now(UTC)
    post(
        conn,
        -1001,
        "message from years ago",
        user_id=1,
        date=int((now - timedelta(days=3650)).timestamp()),
    )
    assert data_rights.apply_retention(conn, now) == 0
    assert conn.execute("SELECT COUNT(*) FROM excerpts WHERE valid_to IS NULL").fetchone()[0] == 1


def test_digest_goes_only_to_members_who_opted_in(conn, owner):
    """K14: visible to all members, but optional."""
    enable(conn, owner, -1001)
    post(conn, -1001, "anyone know a good dentist?", user_id=1)
    post(conn, -1001, "yes, try Dr. Levi", user_id=2)
    ids = {r.member_id for r in digest.recipients(conn, COMMUNITY)}
    assert ids == set()  # nobody opted in, not even the owner
    m1 = acl.get_member_by_telegram(conn, COMMUNITY, 1).id
    digest.set_opt_in(conn, m1, True)
    assert {r.member_id for r in digest.recipients(conn, COMMUNITY)} == {m1}
    digest.set_opt_in(conn, m1, False)
    assert digest.recipients(conn, COMMUNITY) == []


def test_forget_clears_digest_opt_in(conn, owner):
    enable(conn, owner, -1001)
    post(conn, -1001, "hello there", user_id=7)
    m = acl.get_member_by_telegram(conn, COMMUNITY, 7).id
    digest.set_opt_in(conn, m, True)
    data_rights.forget_member(conn, m, datetime.now(UTC))
    assert digest.recipients(conn, COMMUNITY) == []
