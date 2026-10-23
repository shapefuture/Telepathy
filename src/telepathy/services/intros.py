"""Consent-based introduction workflow (P09-01..P09-09, C05).

Flow: /intro text -> need -> best eligible candidate gets an anonymous invite ->
candidate accepts -> requester confirms -> only then both receive each other's contact.
Decline/expiry moves to the next candidate (max 3). All sends go through the outbox.
"""

from __future__ import annotations

import html
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta

from telepathy.domain.experts import match_skills, taxonomy
from telepathy.domain.intro import (
    REQUEST_TTL,
    TERMINAL,
    Actor,
    Introduction,
    IntroEvent,
    IntroStatus,
    InvalidTransition,
    apply,
    due_expiry,
)
from telepathy.domain.types import from_iso, new_id, to_iso
from telepathy.services.messages import payload
from telepathy.storage import outbox
from telepathy.storage.db import audit, transaction
from telepathy.storage.experts import eligible_candidates

REQUESTER_WEEKLY_CAP = 2  # open requests per member per 7 days
MAX_CANDIDATES_PER_NEED = 3
MAX_NEED_CHARS = 500
REMINDER_AFTER = timedelta(hours=24)

ACTIONS = {
    "acc": IntroEvent.CANDIDATE_ACCEPT,
    "dec": IntroEvent.CANDIDATE_DECLINE,
    "conf": IntroEvent.REQUESTER_CONFIRM,
    "cancel": IntroEvent.CANCEL,
    "helpful": IntroEvent.COMPLETE,
    "noresp": IntroEvent.COMPLETE,
}


class IntroError(Exception):
    """User-facing refusal (safe to show)."""


@dataclass(frozen=True, slots=True)
class RequestResult:
    need_id: str
    intro_id: str | None
    skills: list[str]


def _tg(conn: sqlite3.Connection, member_id: str) -> int:
    row = conn.execute("SELECT telegram_user_id FROM members WHERE id=?", (member_id,)).fetchone()
    if row is None or row[0] is None:
        raise IntroError("member has no Telegram identity")
    return int(row[0])


def _load(conn: sqlite3.Connection, intro_id: str) -> Introduction | None:
    r = conn.execute("SELECT * FROM introductions WHERE id=?", (intro_id,)).fetchone()
    if r is None:
        return None
    return Introduction(
        id=r["id"],
        requester_id=r["requester_id"],
        candidate_id=r["candidate_id"],
        status=IntroStatus(r["status"]),
        created_at=from_iso(r["created_at"]),
        updated_at=from_iso(r["updated_at"]),
        invite_expires_at=from_iso(r["invite_expires_at"]) if r["invite_expires_at"] else None,
    )


def _save(conn: sqlite3.Connection, before: Introduction, after: Introduction) -> bool:
    """Optimistic write: fails if someone else moved the intro first (double clicks)."""
    cur = conn.execute(
        "UPDATE introductions SET status=?, candidate_id=?, updated_at=?, invite_expires_at=? "
        "WHERE id=? AND status=?",
        (
            after.status.value,
            after.candidate_id,
            to_iso(after.updated_at),
            to_iso(after.invite_expires_at) if after.invite_expires_at else None,
            after.id,
            before.status.value,
        ),
    )
    return cur.rowcount == 1


def _send(
    conn: sqlite3.Connection,
    key: str,
    chat_id: int,
    text: str,
    now: datetime,
    buttons: list[list[tuple[str, str]]] | None = None,
    reveal_tg_id: int | None = None,
) -> None:
    outbox.create_intent(
        conn,
        "telegram.dm",
        f"tg:{chat_id}",
        payload(chat_id, text, buttons, reveal_tg_id=reveal_tg_id),
        key,
        now=now,
    )


def _need_text(conn: sqlite3.Connection, need_id: str) -> str:
    row = conn.execute("SELECT description FROM needs WHERE id=?", (need_id,)).fetchone()
    return str(row[0]) if row else ""


def request_intro(
    conn: sqlite3.Connection, community_id: str, requester_id: str, text: str, now: datetime
) -> RequestResult:
    text = " ".join(text.split())[:MAX_NEED_CHARS]
    skills = match_skills(text)
    if not skills:
        raise IntroError(
            "I couldn't match that to a skill. Try naming the area, e.g. "
            "<code>/intro accountant for a small startup</code>, or see /skills."
        )
    with transaction(conn):
        open_count = conn.execute(
            "SELECT COUNT(*) FROM needs WHERE member_id=? AND created_at>=? "
            "AND status IN ('open','matching')",
            (requester_id, to_iso(now - timedelta(days=7))),
        ).fetchone()[0]
        if open_count >= REQUESTER_WEEKLY_CAP:
            raise IntroError(
                f"You already have {open_count} open requests this week "
                f"(limit {REQUESTER_WEEKLY_CAP}). Cancel one or wait."
            )
        need_id = new_id()
        conn.execute(
            "INSERT INTO needs(id, community_id, member_id, description, status, expires_at, "
            "created_at, skill_codes_json) VALUES (?,?,?,?, 'open', ?,?,?)",
            (
                need_id,
                community_id,
                requester_id,
                text,
                to_iso(now + REQUEST_TTL),
                to_iso(now),
                json.dumps(skills),
            ),
        )
        audit(
            conn,
            "intro.request",
            actor_member_id=requester_id,
            subject=need_id,
            detail_json=json.dumps({"skills": skills}),
        )
        intro_id = _next_candidate(conn, need_id, now, notify_none=False)
    return RequestResult(need_id, intro_id, skills)


def _next_candidate(
    conn: sqlite3.Connection, need_id: str, now: datetime, *, notify_none: bool = True
) -> str | None:
    """Invite the best remaining candidate. Must run inside a transaction."""
    need = conn.execute("SELECT * FROM needs WHERE id=?", (need_id,)).fetchone()
    if need is None or need["status"] not in ("open", "matching"):
        return None
    tried = frozenset(
        r[0]
        for r in conn.execute(
            "SELECT candidate_id FROM introductions WHERE need_id=? AND candidate_id IS NOT NULL",
            (need_id,),
        )
    )
    requester_tg = _tg(conn, need["member_id"])
    candidates = (
        []
        if len(tried) >= MAX_CANDIDATES_PER_NEED
        else eligible_candidates(
            conn,
            need["community_id"],
            need["member_id"],
            json.loads(need["skill_codes_json"]),
            now,
            exclude=tried,
        )
    )
    if not candidates:
        conn.execute("UPDATE needs SET status='no_match' WHERE id=?", (need_id,))
        if notify_none:
            _send(
                conn,
                f"need:{need_id}:no_match",
                requester_tg,
                "No available expert accepted your request this time, so it is closed. "
                "You can try again later or ask in the community.",
                now,
            )
        return None
    cand_id, total, comp = candidates[0]
    intro = Introduction(
        id=new_id(),
        requester_id=need["member_id"],
        candidate_id=None,
        status=IntroStatus.REQUESTED,
        created_at=now,
        updated_at=now,
    )
    intro = apply(intro, IntroEvent.SELECT_CANDIDATE, Actor.SYSTEM, now, candidate_id=cand_id)
    intro = apply(intro, IntroEvent.INVITE, Actor.SYSTEM, now)
    conn.execute(
        "INSERT INTO introductions(id, need_id, requester_id, candidate_id, status, created_at, "
        "updated_at, invite_expires_at, score_json) VALUES (?,?,?,?,?,?,?,?,?)",
        (
            intro.id,
            need_id,
            intro.requester_id,
            cand_id,
            intro.status.value,
            to_iso(now),
            to_iso(now),
            to_iso(intro.invite_expires_at) if intro.invite_expires_at else None,
            json.dumps({"total": total, **comp}),
        ),
    )
    conn.execute("UPDATE needs SET status='matching' WHERE id=?", (need_id,))
    audit(
        conn,
        "intro.invite",
        subject=intro.id,
        detail_json=json.dumps({"score": total, "components": comp}),
    )
    labels = ", ".join(taxonomy()[c].en for c in json.loads(need["skill_codes_json"]))
    _send(
        conn,
        f"intro:{intro.id}:invite",
        _tg(conn, cand_id),
        "<b>Introduction request</b>\n"
        f"A community member is looking for help with: <i>{html.escape(labels)}</i>\n\n"
        f"<blockquote>{html.escape(need['description'])}</blockquote>\n"
        "Your identity stays private unless you accept <b>and</b> they confirm. "
        "This invitation expires in 72 hours.",
        now,
        [[("Accept", f"i:{intro.id}:acc"), ("Decline", f"i:{intro.id}:dec")]],
    )
    return intro.id


def act(
    conn: sqlite3.Connection, intro_id: str, actor_member_id: str, action: str, now: datetime
) -> str:
    """Apply a button press. Returns a short user-facing reply."""
    event = ACTIONS.get(action)
    if event is None:
        return "Unknown action."
    with transaction(conn):
        intro = _load(conn, intro_id)
        if intro is None:
            return "This introduction no longer exists."
        if actor_member_id == intro.requester_id:
            actor = Actor.REQUESTER
        elif actor_member_id == intro.candidate_id:
            actor = Actor.CANDIDATE
        else:
            return "This introduction is not yours."
        try:
            after = apply(intro, event, actor, now)
        except InvalidTransition:
            return "Already handled, or no longer available."
        if not _save(conn, intro, after):
            return "Already handled."
        need_id = conn.execute(
            "SELECT need_id FROM introductions WHERE id=?", (intro_id,)
        ).fetchone()[0]
        audit(conn, f"intro.{event.value}", actor_member_id=actor_member_id, subject=intro_id)
        return _after(conn, intro, after, need_id, action, actor, now)


def _after(
    conn: sqlite3.Connection,
    before: Introduction,
    after: Introduction,
    need_id: str,
    action: str,
    actor: Actor,
    now: datetime,
) -> str:
    req_tg = _tg(conn, after.requester_id)
    cand_tg = _tg(conn, after.candidate_id) if after.candidate_id else None
    s = after.status
    if s is IntroStatus.ACCEPTED:
        _send(
            conn,
            f"intro:{after.id}:accepted",
            req_tg,
            "<b>Good news:</b> an expert accepted your introduction request.\n"
            f"<blockquote>{html.escape(_need_text(conn, need_id))}</blockquote>\n"
            "Confirm to exchange contacts with them.",
            now,
            [
                [
                    ("Confirm & exchange contacts", f"i:{after.id}:conf"),
                    ("Cancel", f"i:{after.id}:cancel"),
                ]
            ],
        )
        return "Thanks! The requester will now be asked to confirm. Nothing is shared yet."
    if s is IntroStatus.DECLINED:
        _next_candidate(conn, need_id, now)
        return "Declined. Nobody is told who you are."
    if s is IntroStatus.MUTUALLY_CONFIRMED:
        assert cand_tg is not None
        buttons = [
            [("It helped", f"i:{after.id}:helpful"), ("Didn't happen", f"i:{after.id}:noresp")]
        ]
        _send(
            conn,
            f"intro:{after.id}:reveal:req",
            req_tg,
            "<b>You're connected.</b> Here is the expert's contact:",
            now,
            buttons,
            reveal_tg_id=cand_tg,
        )
        _send(
            conn,
            f"intro:{after.id}:reveal:cand",
            cand_tg,
            "<b>You're connected.</b> The requester confirmed. Their contact:\n"
            f"<blockquote>{html.escape(_need_text(conn, need_id))}</blockquote>",
            now,
            buttons,
            reveal_tg_id=req_tg,
        )
        return "Confirmed. Contacts have been shared with both of you."
    if s is IntroStatus.CANCELLED:
        conn.execute(
            "UPDATE needs SET status='cancelled' WHERE id=? AND status IN ('open','matching')",
            (need_id,),
        )
        # Tell the other party only if they had already been contacted.
        other = cand_tg if actor is Actor.REQUESTER else req_tg
        if before.status is not IntroStatus.REQUESTED and other is not None:
            _send(
                conn,
                f"intro:{after.id}:cancelled",
                other,
                "An introduction you were part of was cancelled. Nothing was shared.",
                now,
            )
        return "Cancelled."
    if s is IntroStatus.COMPLETED:
        outcome = "helpful" if action == "helpful" else "no_response"
        conn.execute("UPDATE introductions SET outcome=? WHERE id=?", (outcome, after.id))
        conn.execute("UPDATE needs SET status='closed' WHERE id=?", (need_id,))
        return "Thanks for the feedback! It is private and only improves future matching."
    return "Done."


def cancel_need(conn: sqlite3.Connection, requester_id: str, need_id: str, now: datetime) -> bool:
    live = conn.execute(
        "SELECT id FROM introductions WHERE need_id=? AND requester_id=? AND status NOT IN "
        "('completed','declined','expired','cancelled')",
        (need_id, requester_id),
    ).fetchall()
    for r in live:
        act(conn, r[0], requester_id, "cancel", now)
    with transaction(conn):
        cur = conn.execute(
            "UPDATE needs SET status='cancelled' WHERE id=? AND member_id=? "
            "AND status IN ('open','matching','no_match')",
            (need_id, requester_id),
        )
    return cur.rowcount == 1 or bool(live)


def open_needs(conn: sqlite3.Connection, requester_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, description, status, created_at FROM needs WHERE member_id=? "
        "AND status IN ('open','matching') ORDER BY created_at DESC",
        (requester_id,),
    ).fetchall()


def expire_due(conn: sqlite3.Connection, now: datetime) -> int:
    """System sweep (P09-05): expire stale invitations/requests, move to next candidate."""
    rows = conn.execute(
        "SELECT id FROM introductions WHERE status NOT IN "
        "('completed','declined','expired','cancelled','mutually_confirmed','scheduled')"
    ).fetchall()
    count = 0
    for r in rows:
        with transaction(conn):
            intro = _load(conn, r[0])
            if intro is None or intro.status in TERMINAL or not due_expiry(intro, now):
                continue
            after = apply(intro, IntroEvent.EXPIRE, Actor.SYSTEM, now)
            if not _save(conn, intro, after):
                continue
            count += 1
            need_id = conn.execute(
                "SELECT need_id FROM introductions WHERE id=?", (intro.id,)
            ).fetchone()[0]
            audit(conn, "intro.expire", subject=intro.id)
            need = conn.execute("SELECT expires_at FROM needs WHERE id=?", (need_id,)).fetchone()
            if need and need[0] and from_iso(need[0]) > now:
                _next_candidate(conn, need_id, now)
            else:
                conn.execute("UPDATE needs SET status='expired' WHERE id=?", (need_id,))
    return count


def send_reminders(conn: sqlite3.Connection, now: datetime) -> int:
    """One reminder after 24h for opted-in candidates (P09-08)."""
    rows = conn.execute(
        """
        SELECT i.id, m.telegram_user_id FROM introductions i
        JOIN members m ON m.id = i.candidate_id
        WHERE i.status = 'invited' AND i.reminder_sent_at IS NULL AND i.updated_at <= ?
          AND (i.invite_expires_at IS NULL OR i.invite_expires_at > ?)
          AND m.reminders_opt_in = 1 AND m.removed_at IS NULL
        """,
        (to_iso(now - REMINDER_AFTER), to_iso(now)),
    ).fetchall()
    for r in rows:
        with transaction(conn):
            cur = conn.execute(
                "UPDATE introductions SET reminder_sent_at=? WHERE id=? "
                "AND reminder_sent_at IS NULL AND status='invited'",
                (to_iso(now), r["id"]),
            )
            if cur.rowcount:
                _send(
                    conn,
                    f"intro:{r['id']}:reminder",
                    int(r["telegram_user_id"]),
                    "Reminder: an introduction request is waiting for your answer. "
                    "Ignore this if you're not interested; it expires automatically.",
                    now,
                    [[("Accept", f"i:{r['id']}:acc"), ("Decline", f"i:{r['id']}:dec")]],
                )
    return len(rows)
