"""Exhaustive transition-table tests (P09-10, QG05)."""

from __future__ import annotations

import itertools
from datetime import UTC, datetime, timedelta

import pytest

from telepathy.domain.intro import (
    CONTACT_REVEAL_STATES,
    TERMINAL,
    TRANSITIONS,
    Actor,
    Introduction,
    IntroEvent,
    IntroStatus,
    InvalidTransition,
    apply,
    due_expiry,
)

T0 = datetime(2026, 10, 1, tzinfo=UTC)


def intro(status: IntroStatus = IntroStatus.REQUESTED, **kw) -> Introduction:
    base = dict(
        id="i1",
        requester_id="req",
        candidate_id="cand",
        status=status,
        created_at=T0,
        updated_at=T0,
    )
    base.update(kw)
    return Introduction(**base)


def happy_path() -> Introduction:
    i = intro(candidate_id=None)
    i = apply(i, IntroEvent.SELECT_CANDIDATE, Actor.SYSTEM, T0, candidate_id="cand")
    i = apply(i, IntroEvent.INVITE, Actor.SYSTEM, T0)
    assert i.invite_expires_at == T0 + timedelta(hours=72)
    assert not i.may_reveal_contacts
    i = apply(i, IntroEvent.CANDIDATE_ACCEPT, Actor.CANDIDATE, T0 + timedelta(hours=1))
    assert not i.may_reveal_contacts  # one side agreeing is not enough
    i = apply(i, IntroEvent.REQUESTER_CONFIRM, Actor.REQUESTER, T0 + timedelta(hours=2))
    assert i.may_reveal_contacts
    i = apply(i, IntroEvent.SCHEDULE, Actor.CANDIDATE, T0 + timedelta(hours=3))
    return apply(i, IntroEvent.COMPLETE, Actor.REQUESTER, T0 + timedelta(days=2))


def test_happy_path_reaches_completed():
    assert happy_path().status is IntroStatus.COMPLETED


@pytest.mark.parametrize(
    "status,event,actor",
    list(itertools.product(IntroStatus, IntroEvent, Actor)),
)
def test_every_pair_is_allowed_only_if_in_table(status, event, actor):
    i = intro(status, invite_expires_at=T0 + timedelta(hours=72))
    entry = TRANSITIONS.get((status, event))
    allowed = entry is not None and actor in entry[1]
    if not allowed:
        with pytest.raises(InvalidTransition):
            apply(i, event, actor, T0, candidate_id="cand2")
    else:
        out = apply(i, event, actor, T0, candidate_id="cand2")
        assert out.status is entry[0]


def test_terminal_states_have_no_exits():
    for s, _e in TRANSITIONS:
        assert s not in TERMINAL


def test_contact_reveal_only_after_both_parties_agree():
    # Every path into a reveal state passes through REQUESTER_CONFIRM by the requester,
    # which itself is only reachable from ACCEPTED (candidate's own consent).
    into_reveal = {
        (s, e)
        for (s, e), (to, _) in TRANSITIONS.items()
        if to in CONTACT_REVEAL_STATES and s not in CONTACT_REVEAL_STATES
    }
    assert into_reveal == {(IntroStatus.ACCEPTED, IntroEvent.REQUESTER_CONFIRM)}
    assert TRANSITIONS[(IntroStatus.INVITED, IntroEvent.CANDIDATE_ACCEPT)][1] == {Actor.CANDIDATE}


def test_duplicate_click_is_rejected():
    i = apply(
        intro(IntroStatus.INVITED, invite_expires_at=T0 + timedelta(hours=72)),
        IntroEvent.CANDIDATE_ACCEPT,
        Actor.CANDIDATE,
        T0,
    )
    with pytest.raises(InvalidTransition):
        apply(i, IntroEvent.CANDIDATE_ACCEPT, Actor.CANDIDATE, T0)


def test_accept_after_expiry_is_rejected():
    i = intro(IntroStatus.INVITED, invite_expires_at=T0)
    with pytest.raises(InvalidTransition):
        apply(i, IntroEvent.CANDIDATE_ACCEPT, Actor.CANDIDATE, T0 + timedelta(seconds=1))
    assert due_expiry(i, T0)


def test_request_expires_after_14_days():
    i = intro(IntroStatus.REQUESTED)
    assert not due_expiry(i, T0 + timedelta(days=13))
    assert due_expiry(i, T0 + timedelta(days=14))


def test_self_introduction_rejected():
    with pytest.raises(InvalidTransition):
        apply(
            intro(candidate_id=None),
            IntroEvent.SELECT_CANDIDATE,
            Actor.SYSTEM,
            T0,
            candidate_id="req",
        )
