"""Negative ACL tests (P02-10, P06-02, QG01): hidden evidence must never surface."""

from __future__ import annotations

from conftest import COMMUNITY, ctx_for, enable, post

from telepathy.domain.types import Role, Visibility
from telepathy.ingest.service import disable_source
from telepathy.retrieval.answer import AnswerStatus, answer
from telepathy.retrieval.search import search
from telepathy.storage import acl


def test_member_only_reads_groups_they_are_in(conn, owner):
    enable(conn, owner, -1001)
    enable(conn, owner, -1002)
    post(conn, -1001, "budget for the hackathon is approved", user_id=1)
    post(conn, -1002, "secret budget for salaries", user_id=2)
    hits = search(conn, ctx_for(conn, 1), "budget")
    assert [h.body for h in hits] == ["budget for the hackathon is approved"]


def test_internal_restricted_requires_staff(conn, owner):
    enable(conn, owner, -1003, Visibility.INTERNAL_RESTRICTED)
    post(conn, -1003, "moderator notes about spam", user_id=3)
    assert search(conn, ctx_for(conn, 3), "spam") == []  # posted there, but not staff
    mid = acl.get_member_by_telegram(conn, COMMUNITY, 3).id
    conn.execute("UPDATE members SET role=? WHERE id=?", (Role.MODERATOR.value, mid))
    assert len(search(conn, ctx_for(conn, 3), "spam")) == 1


def test_public_approved_visible_to_all_members(conn, owner):
    enable(conn, owner, -1004, Visibility.PUBLIC_APPROVED)
    enable(conn, owner, -1001)
    post(conn, -1004, "community rules are pinned", user_id=4)
    post(conn, -1001, "hello", user_id=5)  # user 5 never posted in -1004
    assert len(search(conn, ctx_for(conn, 5), "rules")) == 1


def test_disabled_source_disappears_immediately(conn, owner):
    enable(conn, owner, -1001)
    post(conn, -1001, "venue is the old library", user_id=1)
    assert len(search(conn, ctx_for(conn, 1), "venue library")) == 1
    disable_source(conn, COMMUNITY, -1001, actor_member_id=owner)
    assert search(conn, ctx_for(conn, 1), "venue library") == []


def test_revoked_access_and_removed_member(conn, owner):
    sid = enable(conn, owner, -1001)
    post(conn, -1001, "parking code instructions", user_id=1)
    mid = acl.get_member_by_telegram(conn, COMMUNITY, 1).id
    acl.revoke_source_access(conn, sid, mid)
    assert search(conn, ctx_for(conn, 1), "parking") == []
    acl.grant_source_access(conn, sid, mid, "chat_member")
    assert len(search(conn, ctx_for(conn, 1), "parking")) == 1
    conn.execute("UPDATE members SET removed_at='2026-01-01T00:00:00+00:00' WHERE id=?", (mid,))
    assert ctx_for(conn, 1) is None


def test_unknown_user_gets_nothing(conn, owner):
    enable(conn, owner, -1001, Visibility.PUBLIC_APPROVED)
    post(conn, -1001, "anything", user_id=1)
    assert ctx_for(conn, 999) is None


def test_cross_community_isolation(conn, owner):
    from conftest import tg_message

    from telepathy.ingest.normalize import normalize_message
    from telepathy.ingest.service import enable_source, ingest
    from telepathy.storage import db

    db.ensure_community(conn, "c2", "Other", "UTC")
    other_owner = acl.upsert_member(conn, "c2", 2000)
    enable_source(
        conn, "c2", -2001, visibility=Visibility.PUBLIC_APPROVED, enabled_by_member_id=other_owner
    )
    ingest(conn, "c2", normalize_message(tg_message(-2001, "other community roadmap", user_id=1)))
    enable(conn, owner, -1001, Visibility.PUBLIC_APPROVED)
    post(conn, -1001, "our roadmap", user_id=1)
    hits = search(conn, ctx_for(conn, 1), "roadmap")
    assert [h.body for h in hits] == ["our roadmap"]


def test_forged_context_cannot_read_unauthorized_source(conn, owner):
    """Even a caller-supplied source id is re-checked against the community at verify time."""
    from dataclasses import replace

    enable(conn, owner, -1001)
    post(conn, -1001, "public info", user_id=1)
    ctx = ctx_for(conn, 1)
    bad = replace(ctx, community_id="nope")
    assert search(conn, bad, "public info") == []


def test_answer_reports_no_access(conn, owner):
    enable(conn, owner, -1001)
    post(conn, -1001, "x", user_id=1)
    sid_rows = conn.execute("SELECT id FROM sources").fetchall()
    mid = acl.get_member_by_telegram(conn, COMMUNITY, 1).id
    for r in sid_rows:
        acl.revoke_source_access(conn, r[0], mid)
    assert answer(conn, ctx_for(conn, 1), "anything here").status is AnswerStatus.NO_ACCESS
