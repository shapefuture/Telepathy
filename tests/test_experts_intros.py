"""Expert eligibility/ranking and the full introduction workflow (QG04, QG05)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from conftest import COMMUNITY, enable, post

from telepathy.domain.experts import CandidateSignals, match_skills, resolve_skill, score, taxonomy
from telepathy.services import intros
from telepathy.storage import acl, experts, outbox

T0 = datetime(2026, 10, 1, 9, 0, tzinfo=UTC)


def member(conn, tg: int) -> str:
    return acl.get_member_by_telegram(conn, COMMUNITY, tg).id


@pytest.fixture
def world(conn, owner):
    """Group with requester (tg 1) and three experts (tg 11, 12, 13)."""
    enable(conn, owner, -1001)
    for tg in (1, 11, 12, 13, 14):
        post(conn, -1001, f"hello from {tg}", user_id=tg)
    for tg in (11, 12, 13):
        mid = member(conn, tg)
        experts.set_discovery(conn, mid, True, T0)
        experts.add_skill(conn, mid, "accounting", T0)
    # 14 has the skill but never opted in.
    experts.add_skill(conn, member(conn, 14), "accounting", T0)
    return conn


def sent_texts(conn) -> list[tuple[str, str]]:
    return [
        (r["target"], r["idempotency_key"])
        for r in conn.execute(
            "SELECT target, idempotency_key FROM effect_intents ORDER BY created_at, rowid"
        )
    ]


def test_taxonomy_has_100_unique_skills():
    assert len(taxonomy()) == 100


@pytest.mark.parametrize(
    "text,code",
    [
        ("need an accountant for a startup", "accounting"),
        ("ищу бухгалтера для ИП", "accounting"),
        ("help with kubernetes deploy", "devops"),
        ("виза для родителей", "legal_immigration"),
    ],
)
def test_match_skills(text, code):
    assert code in match_skills(text)


def test_resolve_skill():
    assert resolve_skill("accounting") == "accounting"
    assert resolve_skill("Python") == "python"
    assert resolve_skill("zzzz") is None


def test_score_weights_and_bounds():
    total, comp = score(CandidateSignals("m", 1, 1, 0, 0, "self_claim", 1, 1, 0, 2))
    assert set(comp) == {"domain", "helpfulness", "evidence", "context", "fairness"}
    assert 0 <= total <= 1
    busy, _ = score(CandidateSignals("m", 1, 1, 0, 0, "self_claim", 1, 1, 1, 2))
    assert busy < total  # workload fairness


def test_eligibility_requires_opt_in_and_skill(world):
    req = member(world, 1)
    ids = {c[0] for c in experts.eligible_candidates(world, COMMUNITY, req, ["accounting"], T0)}
    assert ids == {member(world, 11), member(world, 12), member(world, 13)}
    experts.set_discovery(world, member(world, 11), False, T0)
    experts.set_flag(world, member(world, 12), "available", False)
    ids = {c[0] for c in experts.eligible_candidates(world, COMMUNITY, req, ["accounting"], T0)}
    assert ids == {member(world, 13)}
    assert experts.eligible_candidates(world, COMMUNITY, req, ["tax"], T0) == []


def test_requester_is_never_own_candidate(world):
    mid = member(world, 11)
    ids = {c[0] for c in experts.eligible_candidates(world, COMMUNITY, mid, ["accounting"], T0)}
    assert mid not in ids


def test_full_intro_happy_path_reveals_only_after_mutual_consent(world):
    req = member(world, 1)
    res = intros.request_intro(world, COMMUNITY, req, "need an accountant for my startup", T0)
    assert res.intro_id
    cand = world.execute(
        "SELECT candidate_id FROM introductions WHERE id=?", (res.intro_id,)
    ).fetchone()[0]
    cand_tg = world.execute("SELECT telegram_user_id FROM members WHERE id=?", (cand,)).fetchone()[
        0
    ]
    keys = [k for _, k in sent_texts(world)]
    assert keys == [f"intro:{res.intro_id}:invite"]
    # No reveal payload exists before both consent.
    assert (
        world.execute(
            "SELECT COUNT(*) FROM effect_intents WHERE payload_json LIKE '%reveal_tg_id%'"
        ).fetchone()[0]
        == 0
    )

    assert "not yours" in intros.act(world, res.intro_id, member(world, 14), "acc", T0)
    assert "Already handled" in intros.act(world, res.intro_id, req, "acc", T0)  # wrong actor
    intros.act(world, res.intro_id, cand, "acc", T0)
    assert (
        world.execute(
            "SELECT COUNT(*) FROM effect_intents WHERE payload_json LIKE '%reveal_tg_id%'"
        ).fetchone()[0]
        == 0
    )
    intros.act(world, res.intro_id, req, "conf", T0)
    reveals = world.execute(
        "SELECT target, payload_json FROM effect_intents WHERE payload_json LIKE '%reveal_tg_id%'"
    ).fetchall()
    assert len(reveals) == 2
    assert {r["target"] for r in reveals} == {"tg:1", f"tg:{cand_tg}"}
    # Double click after completion is harmless.
    assert "Already handled" in intros.act(world, res.intro_id, req, "conf", T0)
    intros.act(world, res.intro_id, cand, "helpful", T0)
    row = world.execute(
        "SELECT status, outcome FROM introductions WHERE id=?", (res.intro_id,)
    ).fetchone()
    assert tuple(row) == ("completed", "helpful")


def test_decline_moves_to_next_candidate_then_closes(world):
    req = member(world, 1)
    res = intros.request_intro(world, COMMUNITY, req, "need an accountant please", T0)
    seen = set()
    intro_id = res.intro_id
    for _ in range(3):
        cand = world.execute(
            "SELECT candidate_id FROM introductions WHERE id=?", (intro_id,)
        ).fetchone()[0]
        assert cand not in seen
        seen.add(cand)
        intros.act(world, intro_id, cand, "dec", T0)
        nxt = world.execute("SELECT id FROM introductions WHERE status='invited'").fetchone()
        intro_id = nxt[0] if nxt else None
    assert intro_id is None
    status = world.execute("SELECT status FROM needs").fetchone()[0]
    assert status == "no_match"
    assert any(k.endswith(":no_match") for _, k in sent_texts(world))


def test_requester_weekly_cap(world):
    req = member(world, 1)
    intros.request_intro(world, COMMUNITY, req, "need an accountant one", T0)
    intros.request_intro(world, COMMUNITY, req, "need an accountant two", T0)
    with pytest.raises(intros.IntroError):
        intros.request_intro(world, COMMUNITY, req, "need an accountant three", T0)
    # Cap counts only the last 7 days.
    intros.request_intro(world, COMMUNITY, req, "need an accountant four", T0 + timedelta(days=8))


def test_expert_weekly_cap(world):
    # Only one expert left -> it receives at most 2 pending invites per week.
    for tg in (11, 12):
        experts.set_discovery(world, member(world, tg), False, T0)
    for i, tg in enumerate((1, 14, 11)):
        mid = member(world, tg)
        res = intros.request_intro(world, COMMUNITY, mid, f"need an accountant {i} now", T0)
        if i < 2:
            assert res.intro_id
        else:
            assert res.intro_id is None


def test_unmatched_text_is_refused(world):
    with pytest.raises(intros.IntroError):
        intros.request_intro(world, COMMUNITY, member(world, 1), "qwerty asdfgh zxcvb", T0)


def test_invitation_expiry_and_reminder(world):
    req = member(world, 1)
    res = intros.request_intro(world, COMMUNITY, req, "need an accountant asap", T0)
    assert intros.send_reminders(world, T0 + timedelta(hours=23)) == 0
    assert intros.send_reminders(world, T0 + timedelta(hours=25)) == 1
    assert intros.send_reminders(world, T0 + timedelta(hours=26)) == 0  # only once
    assert intros.expire_due(world, T0 + timedelta(hours=73)) == 1
    st = world.execute("SELECT status FROM introductions WHERE id=?", (res.intro_id,)).fetchone()
    assert st[0] == "expired"
    # The next candidate was invited automatically.
    assert (
        world.execute("SELECT COUNT(*) FROM introductions WHERE status='invited'").fetchone()[0]
        == 1
    )


def test_no_reminder_after_decline(world):
    req = member(world, 1)
    res = intros.request_intro(world, COMMUNITY, req, "need an accountant asap", T0)
    cand = world.execute(
        "SELECT candidate_id FROM introductions WHERE id=?", (res.intro_id,)
    ).fetchone()[0]
    experts.set_discovery(world, member(world, 12), False, T0)
    experts.set_discovery(world, member(world, 13), False, T0)
    experts.set_discovery(world, member(world, 11), False, T0)
    intros.act(world, res.intro_id, cand, "dec", T0)
    assert intros.send_reminders(world, T0 + timedelta(hours=30)) == 0


def test_cancel_need_notifies_invited_candidate(world):
    req = member(world, 1)
    res = intros.request_intro(world, COMMUNITY, req, "need an accountant asap", T0)
    assert intros.cancel_need(world, req, res.need_id, T0)
    keys = [k for _, k in sent_texts(world)]
    assert f"intro:{res.intro_id}:cancelled" in keys


def test_outbox_delivery_of_intro_messages(world):
    req = member(world, 1)
    intros.request_intro(world, COMMUNITY, req, "need an accountant asap", T0)
    calls = []

    async def send(target, payload):
        calls.append((target, payload))
        return "1"

    for eid in outbox.pending_ids(world):
        asyncio.run(outbox.dispatch(world, eid, send, now=lambda: T0))
    assert len(calls) == 1 and calls[0][1]["buttons"][0][0][1].endswith(":acc")
    assert "Secret" not in calls[0][1]["text"]  # requester's name never included
