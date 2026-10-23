from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from telepathy.storage import jobs, outbox
from telepathy.storage.outbox import DefiniteFailure

T0 = datetime(2026, 10, 1, tzinfo=UTC)


def test_job_dedup_and_lease(conn):
    assert jobs.enqueue(conn, "digest", "digest:2026-10-01", {"d": 1}, now=T0)
    assert not jobs.enqueue(conn, "digest", "digest:2026-10-01", {"d": 2}, now=T0)
    j = jobs.lease(conn, "w1", now=T0)
    assert j and j.payload == {"d": 1} and j.attempts == 1
    assert jobs.lease(conn, "w2", now=T0) is None  # held
    assert jobs.complete(conn, j, now=T0)


def test_expired_lease_is_reclaimed_and_stale_worker_cannot_complete(conn):
    jobs.enqueue(conn, "k", "k1", {}, now=T0)
    j1 = jobs.lease(conn, "w1", now=T0, lease_for=timedelta(seconds=30))
    j2 = jobs.lease(conn, "w2", now=T0 + timedelta(seconds=31))
    assert j1 and j2 and j2.attempts == 2
    assert not jobs.complete(conn, j1, now=T0 + timedelta(seconds=32))
    assert jobs.complete(conn, j2, now=T0 + timedelta(seconds=32))


def test_job_backoff_then_failed(conn):
    jobs.enqueue(conn, "k", "k1", {}, now=T0, max_attempts=2)
    j = jobs.lease(conn, "w", now=T0)
    assert jobs.fail(conn, j, "429", now=T0, retry_after=timedelta(seconds=10)) == "pending"
    assert jobs.lease(conn, "w", now=T0 + timedelta(seconds=5)) is None
    j = jobs.lease(conn, "w", now=T0 + timedelta(seconds=10))
    assert jobs.fail(conn, j, "503", now=T0) == "failed"


def _run(coro):
    return asyncio.run(coro)


def test_outbox_success_and_idempotent_intent(conn):
    e1 = outbox.create_intent(conn, "dm", "tg:1", {"t": "hi"}, "intro:1:invite", now=T0)
    e2 = outbox.create_intent(conn, "dm", "tg:1", {"t": "hi"}, "intro:1:invite", now=T0)
    assert e1 == e2
    calls = []

    async def send(target, payload):
        calls.append(target)
        return "msg-9"

    assert _run(outbox.dispatch(conn, e1, send, now=lambda: T0)) == "sent"
    assert _run(outbox.dispatch(conn, e1, send, now=lambda: T0)) == "sent"
    assert calls == ["tg:1"]  # never sent twice


def test_outbox_unknown_outcome_becomes_uncertain_and_is_not_resent(conn):
    e = outbox.create_intent(conn, "dm", "tg:1", {}, "k", now=T0)

    async def flaky(target, payload):
        raise TimeoutError("read timeout")

    assert _run(outbox.dispatch(conn, e, flaky, now=lambda: T0)) == "uncertain"

    async def boom(target, payload):
        raise AssertionError("must not resend uncertain effect")

    assert _run(outbox.dispatch(conn, e, boom, now=lambda: T0)) == "uncertain"
    assert outbox.reconcile(conn, e, delivered=True, now=T0, note="seen in chat")
    assert outbox.state_of(conn, e) == "reconciled"


def test_outbox_definite_failure(conn):
    e = outbox.create_intent(conn, "dm", "tg:1", {}, "k", now=T0)

    async def blocked(target, payload):
        raise DefiniteFailure("403 bot was blocked by the user")

    assert _run(outbox.dispatch(conn, e, blocked, now=lambda: T0)) == "failed"


def test_crash_recovery_marks_dispatching_uncertain(conn):
    e = outbox.create_intent(conn, "dm", "tg:1", {}, "k", now=T0)
    conn.execute("UPDATE effect_intents SET state='dispatching' WHERE id=?", (e,))
    assert outbox.recover_after_crash(conn, now=T0) == 1
    assert outbox.state_of(conn, e) == "uncertain"


def test_one_live_invitation_per_need(conn, owner):
    import sqlite3

    conn.execute("INSERT INTO needs VALUES ('n1','c1',?, 'x','open',NULL,'t')", (owner,))
    from telepathy.storage import acl

    a = acl.upsert_member(conn, "c1", 1)
    b = acl.upsert_member(conn, "c1", 2)
    sql = (
        "INSERT INTO introductions(id, need_id, requester_id, candidate_id, status, "
        "created_at, updated_at) VALUES (?, 'n1', ?, ?, 'invited', 't', 't')"
    )
    conn.execute(sql, ("i1", owner, a))
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(sql, ("i2", owner, b))
