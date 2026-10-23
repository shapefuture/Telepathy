"""Core value types shared across layers."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum


class Visibility(StrEnum):
    """Data categories (P00-03). Ordered from least to most restricted."""

    PUBLIC_APPROVED = "PUBLIC_APPROVED"
    MEMBER_CONSENTED = "MEMBER_CONSENTED"
    INTERNAL_RESTRICTED = "INTERNAL_RESTRICTED"
    PRIVATE_UNKNOWN = "PRIVATE_UNKNOWN"


class Role(StrEnum):
    MEMBER = "member"
    MODERATOR = "moderator"
    ADMIN = "admin"
    OWNER = "owner"

    @property
    def rank(self) -> int:
        return _ROLE_RANK[self]

    def at_least(self, other: Role) -> bool:
        return self.rank >= other.rank


_ROLE_RANK = {Role.MEMBER: 0, Role.MODERATOR: 1, Role.ADMIN: 2, Role.OWNER: 3}


def new_id() -> str:
    return uuid.uuid4().hex


def utcnow() -> datetime:
    return datetime.now(UTC)


def to_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        raise ValueError("naive datetime; all stored times must be UTC-aware")
    return dt.astimezone(UTC).isoformat(timespec="seconds")


def from_iso(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        raise ValueError(f"stored timestamp without timezone: {value!r}")
    return dt


@dataclass(frozen=True, slots=True)
class AccessContext:
    """Who is asking, resolved from a verified platform identity (P06-01).

    Never build this from free-form IDs supplied in a request body.
    """

    community_id: str
    member_id: str
    role: Role
    readable_source_ids: frozenset[str] = field(default_factory=frozenset)
