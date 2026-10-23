"""Expert profiles: consent, skills, eligibility (P08-02, P08-04, P08-06, P08-09)."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta

from telepathy.domain.experts import CandidateSignals, score, taxonomy
from telepathy.domain.types import new_id, to_iso
from telepathy.storage import acl
from telepathy.storage.db import audit

DISCOVERY = "discovery"
CONSENT_VERSION = 1
EXPERT_WEEKLY_CAP = 2  # pending invitations per expert per 7 days
LIVE_INTRO = ("candidate_selected", "invited", "accepted")


@dataclass(frozen=True, slots=True)
class Profile:
    member_id: str
    discoverable: bool
    available: bool
    reminders: bool
    collection_opt_out: bool
    skills: list[tuple[str, str]]  # (code, state)


def set_discovery(conn: sqlite3.Connection, member_id: str, on: bool, now: datetime) -> None:
    ts = to_iso(now)
    if on:
        conn.execute(
            "INSERT INTO consent(id, member_id, purpose, granted, granted_at, version) "
            "VALUES (?,?,?,1,?,?) ON CONFLICT(member_id, purpose, version) DO UPDATE SET "
            "granted=1, granted_at=excluded.granted_at, revoked_at=NULL",
            (new_id(), member_id, DISCOVERY, ts, CONSENT_VERSION),
        )
    else:
        conn.execute(
            "UPDATE consent SET granted=0, revoked_at=? WHERE member_id=? AND purpose=? "
            "AND granted=1",
            (ts, member_id, DISCOVERY),
        )
    conn.execute("UPDATE members SET discovery_opt_in=? WHERE id=?", (int(on), member_id))
    audit(
        conn,
        "consent.discovery",
        actor_member_id=member_id,
        subject=member_id,
        detail_json=json.dumps({"granted": on}),
    )


def set_flag(conn: sqlite3.Connection, member_id: str, flag: str, on: bool) -> None:
    if flag not in ("available", "reminders_opt_in"):
        raise ValueError(flag)
    conn.execute(f"UPDATE members SET {flag}=? WHERE id=?", (int(on), member_id))


def add_skill(conn: sqlite3.Connection, member_id: str, code: str, now: datetime) -> None:
    """A member's own claim is confirmed immediately (it is their statement)."""
    if code not in taxonomy():
        raise ValueError(f"unknown skill {code}")
    conn.execute(
        "INSERT INTO skill_claims(id, member_id, skill_code, state, evidence_kind, confirmed_at, "
        "visibility) VALUES (?,?,?,'confirmed','self_claim',?, 'discoverable') "
        "ON CONFLICT(member_id, skill_code) DO UPDATE SET state='confirmed', "
        "confirmed_at=excluded.confirmed_at, visibility='discoverable', valid_to=NULL",
        (new_id(), member_id, code, to_iso(now)),
    )


def suggest_skill(
    conn: sqlite3.Connection, member_id: str, code: str, evidence_excerpt_id: str | None
) -> None:
    """Auto-detected skills stay private suggestions until the member confirms (P08-04)."""
    conn.execute(
        "INSERT OR IGNORE INTO skill_claims(id, member_id, skill_code, state, evidence_kind, "
        "evidence_excerpt_id, visibility) VALUES (?,?,?,'suggested','weak_conversation_signal',"
        "?, 'private')",
        (new_id(), member_id, code, evidence_excerpt_id),
    )


def remove_skill(conn: sqlite3.Connection, member_id: str, code: str, now: datetime) -> bool:
    cur = conn.execute(
        "UPDATE skill_claims SET state='withdrawn', visibility='private', valid_to=? "
        "WHERE member_id=? AND skill_code=? AND state!='withdrawn'",
        (to_iso(now), member_id, code),
    )
    return cur.rowcount == 1


def get_profile(conn: sqlite3.Connection, member_id: str) -> Profile:
    m = conn.execute(
        "SELECT discovery_opt_in, available, reminders_opt_in, collection_opt_out FROM members "
        "WHERE id=?",
        (member_id,),
    ).fetchone()
    skills = conn.execute(
        "SELECT skill_code, state FROM skill_claims WHERE member_id=? AND state!='withdrawn' "
        "ORDER BY skill_code",
        (member_id,),
    ).fetchall()
    return Profile(
        member_id,
        bool(m["discovery_opt_in"]),
        bool(m["available"]),
        bool(m["reminders_opt_in"]),
        bool(m["collection_opt_out"]),
        [(r["skill_code"], r["state"]) for r in skills],
    )


def pending_invites_this_week(conn: sqlite3.Connection, member_id: str, now: datetime) -> int:
    row = conn.execute(
        "SELECT COUNT(*) FROM introductions WHERE candidate_id=? AND created_at>=? "
        "AND status IN ('candidate_selected','invited','accepted')",
        (member_id, to_iso(now - timedelta(days=7))),
    ).fetchone()
    return int(row[0])


def _evidence_rank(kind: str) -> int:
    order = [
        "weak_conversation_signal",
        "self_claim",
        "teaching_contribution",
        "validated_role",
        "confirmed_help_outcome",
    ]
    return order.index(kind) if kind in order else -1


def eligible_candidates(
    conn: sqlite3.Connection,
    community_id: str,
    requester_id: str,
    skill_codes: list[str],
    now: datetime,
    *,
    exclude: frozenset[str] = frozenset(),
) -> list[tuple[str, float, dict[str, float]]]:
    """Hard filters first, then score. Returns [(member_id, total, components)], best first."""
    if not skill_codes:
        return []
    codes_json = json.dumps(skill_codes)
    rows = conn.execute(
        """
        SELECT m.id AS member_id,
               COUNT(DISTINCT sc.skill_code) AS matched,
               GROUP_CONCAT(sc.evidence_kind) AS kinds
        FROM members m
        JOIN consent c ON c.member_id = m.id AND c.purpose = ? AND c.granted = 1
                       AND c.revoked_at IS NULL
        JOIN skill_claims sc ON sc.member_id = m.id AND sc.state = 'confirmed'
                            AND sc.visibility = 'discoverable'
                            AND sc.skill_code IN (SELECT value FROM json_each(?))
        WHERE m.community_id = ? AND m.removed_at IS NULL AND m.discovery_opt_in = 1
          AND m.available = 1 AND m.id != ?
          -- no concurrent live intro between the same two people
          AND NOT EXISTS (SELECT 1 FROM introductions i WHERE i.candidate_id = m.id
                          AND i.requester_id = ? AND i.status IN
                          ('candidate_selected','invited','accepted'))
        GROUP BY m.id
        """,
        (DISCOVERY, codes_json, community_id, requester_id, requester_id),
    ).fetchall()
    req_sources = acl.readable_source_ids(conn, community_id, requester_id)
    out: list[tuple[str, float, dict[str, float]]] = []
    for r in rows:
        mid = r["member_id"]
        if mid in exclude:
            continue
        pending = pending_invites_this_week(conn, mid, now)
        if pending >= EXPERT_WEEKLY_CAP:
            continue
        kinds = (r["kinds"] or "").split(",")
        best = max(kinds, key=_evidence_rank) if kinds else "self_claim"
        hist = conn.execute(
            "SELECT COUNT(*) AS done, SUM(outcome='helpful') AS helpful FROM introductions "
            "WHERE candidate_id=? AND status='completed'",
            (mid,),
        ).fetchone()
        cand_sources = acl.readable_source_ids(conn, community_id, mid)
        total, comp = score(
            CandidateSignals(
                member_id=mid,
                matched_skills=r["matched"],
                needed_skills=len(skill_codes),
                helpful_outcomes=int(hist["helpful"] or 0),
                completed_intros=int(hist["done"] or 0),
                best_evidence_kind=best,
                shared_sources=len(req_sources & cand_sources),
                requester_sources=len(req_sources),
                pending_this_week=pending,
                weekly_cap=EXPERT_WEEKLY_CAP,
            )
        )
        out.append((mid, total, comp))
    out.sort(key=lambda t: (-t[1], t[0]))
    return out
