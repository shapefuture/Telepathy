"""Consent-based introduction state machine (P09-03, P09-04, C05).

requested > candidate_selected > invited > accepted > mutually_confirmed > scheduled > completed
Terminal: completed, declined, expired, cancelled.

Pure and table-driven so every (state, event) pair can be tested exhaustively (P09-10).
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from enum import StrEnum


class IntroStatus(StrEnum):
    REQUESTED = "requested"
    CANDIDATE_SELECTED = "candidate_selected"
    INVITED = "invited"
    ACCEPTED = "accepted"
    MUTUALLY_CONFIRMED = "mutually_confirmed"
    SCHEDULED = "scheduled"
    COMPLETED = "completed"
    DECLINED = "declined"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


class IntroEvent(StrEnum):
    SELECT_CANDIDATE = "select_candidate"
    INVITE = "invite"
    CANDIDATE_ACCEPT = "candidate_accept"
    CANDIDATE_DECLINE = "candidate_decline"
    REQUESTER_CONFIRM = "requester_confirm"
    SCHEDULE = "schedule"
    COMPLETE = "complete"
    EXPIRE = "expire"
    CANCEL = "cancel"


class Actor(StrEnum):
    REQUESTER = "requester"
    CANDIDATE = "candidate"
    SYSTEM = "system"


TERMINAL = frozenset(
    {IntroStatus.COMPLETED, IntroStatus.DECLINED, IntroStatus.EXPIRED, IntroStatus.CANCELLED}
)
# Contact details may be released only once both parties have explicitly agreed.
CONTACT_REVEAL_STATES = frozenset(
    {IntroStatus.MUTUALLY_CONFIRMED, IntroStatus.SCHEDULED, IntroStatus.COMPLETED}
)

INVITATION_TTL = timedelta(hours=72)
REQUEST_TTL = timedelta(days=14)

S, E, A = IntroStatus, IntroEvent, Actor

# (from_state, event) -> (to_state, allowed actors)
TRANSITIONS: dict[tuple[IntroStatus, IntroEvent], tuple[IntroStatus, frozenset[Actor]]] = {
    (S.REQUESTED, E.SELECT_CANDIDATE): (S.CANDIDATE_SELECTED, frozenset({A.SYSTEM, A.REQUESTER})),
    (S.CANDIDATE_SELECTED, E.INVITE): (S.INVITED, frozenset({A.SYSTEM})),
    (S.INVITED, E.CANDIDATE_ACCEPT): (S.ACCEPTED, frozenset({A.CANDIDATE})),
    (S.INVITED, E.CANDIDATE_DECLINE): (S.DECLINED, frozenset({A.CANDIDATE})),
    (S.ACCEPTED, E.REQUESTER_CONFIRM): (S.MUTUALLY_CONFIRMED, frozenset({A.REQUESTER})),
    (S.MUTUALLY_CONFIRMED, E.SCHEDULE): (S.SCHEDULED, frozenset({A.REQUESTER, A.CANDIDATE})),
    (S.MUTUALLY_CONFIRMED, E.COMPLETE): (S.COMPLETED, frozenset({A.REQUESTER, A.CANDIDATE})),
    (S.SCHEDULED, E.COMPLETE): (S.COMPLETED, frozenset({A.REQUESTER, A.CANDIDATE, A.SYSTEM})),
}
for _s in (S.REQUESTED, S.CANDIDATE_SELECTED, S.INVITED, S.ACCEPTED):
    TRANSITIONS[(_s, E.EXPIRE)] = (S.EXPIRED, frozenset({A.SYSTEM}))
for _s in (
    S.REQUESTED,
    S.CANDIDATE_SELECTED,
    S.INVITED,
    S.ACCEPTED,
    S.MUTUALLY_CONFIRMED,
    S.SCHEDULED,
):
    TRANSITIONS[(_s, E.CANCEL)] = (S.CANCELLED, frozenset({A.REQUESTER, A.CANDIDATE}))


class InvalidTransition(Exception):
    pass


@dataclass(frozen=True, slots=True)
class Introduction:
    id: str
    requester_id: str
    candidate_id: str | None
    status: IntroStatus
    created_at: datetime
    updated_at: datetime
    invite_expires_at: datetime | None = None

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL

    @property
    def may_reveal_contacts(self) -> bool:
        return self.status in CONTACT_REVEAL_STATES


def apply(
    intro: Introduction,
    event: IntroEvent,
    actor: Actor,
    now: datetime,
    *,
    candidate_id: str | None = None,
) -> Introduction:
    """Return the next state or raise InvalidTransition. Never mutates input."""
    key = (intro.status, event)
    if key not in TRANSITIONS:
        raise InvalidTransition(f"{event} not allowed from {intro.status}")
    to_state, actors = TRANSITIONS[key]
    if actor not in actors:
        raise InvalidTransition(f"{actor} may not {event} from {intro.status}")

    if (
        event in (E.CANDIDATE_ACCEPT,)
        and intro.invite_expires_at
        and now >= intro.invite_expires_at
    ):
        raise InvalidTransition("invitation already expired")

    changes: dict[str, object] = {"status": to_state, "updated_at": now}
    if event is E.SELECT_CANDIDATE:
        if not candidate_id:
            raise InvalidTransition("select_candidate requires candidate_id")
        if candidate_id == intro.requester_id:
            raise InvalidTransition("requester cannot be their own candidate")
        changes["candidate_id"] = candidate_id
    elif event is E.INVITE:
        changes["invite_expires_at"] = now + INVITATION_TTL
    return replace(intro, **changes)  # type: ignore[arg-type]


def due_expiry(intro: Introduction, now: datetime) -> bool:
    """True when the system should fire EXPIRE (P09-05)."""
    if intro.is_terminal:
        return False
    if intro.status is S.INVITED and intro.invite_expires_at and now >= intro.invite_expires_at:
        return True
    return intro.status in (S.REQUESTED, S.CANDIDATE_SELECTED, S.INVITED, S.ACCEPTED) and (
        now >= intro.created_at + REQUEST_TTL
    )
