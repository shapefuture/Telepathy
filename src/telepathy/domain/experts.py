"""Skill taxonomy and expert ranking (P08-01, P08-05, P08-07, P08-08).

Ranking happens only among candidates that already passed hard eligibility
(storage.experts.eligible_candidates). No personality, health or inferred private
traits are ever scored, and a classifier label is never competence evidence (C08).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources

from telepathy.domain.text import normalize, stem_key, tokens

WEIGHTS = {
    "domain": 0.40,
    "helpfulness": 0.25,
    "evidence": 0.15,
    "context": 0.10,
    "fairness": 0.10,
}

EVIDENCE_WEIGHT = {
    "validated_role": 1.0,
    "confirmed_help_outcome": 1.0,
    "teaching_contribution": 0.8,
    "self_claim": 0.5,
    "weak_conversation_signal": 0.0,  # never enough on its own
}


@dataclass(frozen=True, slots=True)
class Skill:
    code: str
    en: str
    ru: str
    synonyms: tuple[str, ...]

    def label(self) -> str:
        return self.en if self.en == self.ru else f"{self.en} / {self.ru}"


@lru_cache(maxsize=1)
def taxonomy() -> dict[str, Skill]:
    raw = json.loads(
        resources.files("telepathy.data").joinpath("skills.json").read_text(encoding="utf-8")
    )
    return {
        s["code"]: Skill(s["code"], s["en"], s["ru"], tuple(s["synonyms"])) for s in raw["skills"]
    }


@lru_cache(maxsize=1)
def _phrase_index() -> list[tuple[str, str]]:
    """(normalized phrase, code), longest phrases first."""
    out: list[tuple[str, str]] = []
    for s in taxonomy().values():
        for phrase in (s.code.replace("_", " "), s.en, s.ru, *s.synonyms):
            out.append((normalize(phrase), s.code))
    return sorted(set(out), key=lambda p: -len(p[0]))


def match_skills(text: str, *, limit: int = 3) -> list[str]:
    """Map free text to taxonomy codes. Multi-word phrases match as substrings,
    single words match on an inflection-tolerant prefix."""
    folded = normalize(text)
    words = tokens(text)
    found: dict[str, None] = {}
    for phrase, code in _phrase_index():
        if " " in phrase or not phrase.isalnum():
            hit = phrase in folded
        else:
            key = stem_key(phrase)
            hit = any(w == phrase or (len(phrase) >= 5 and w.startswith(key)) for w in words)
        if hit:
            found.setdefault(code, None)
        if len(found) >= limit:
            break
    return list(found)


def resolve_skill(text: str) -> str | None:
    """Exact code, or the single best match for a user-typed skill name."""
    t = normalize(text).strip().replace(" ", "_")
    if t in taxonomy():
        return t
    matches = match_skills(text, limit=1)
    return matches[0] if matches else None


@dataclass(frozen=True, slots=True)
class CandidateSignals:
    member_id: str
    matched_skills: int  # confirmed skills matching the need
    needed_skills: int
    helpful_outcomes: int
    completed_intros: int
    best_evidence_kind: str
    shared_sources: int
    requester_sources: int
    pending_this_week: int
    weekly_cap: int


def score(c: CandidateSignals) -> tuple[float, dict[str, float]]:
    """Return (total, components). Components are logged for auditability."""
    comp = {
        "domain": c.matched_skills / c.needed_skills if c.needed_skills else 0.0,
        # Laplace-smoothed so a new expert is not zeroed out.
        "helpfulness": (c.helpful_outcomes + 1) / (c.completed_intros + 2),
        "evidence": EVIDENCE_WEIGHT.get(c.best_evidence_kind, 0.0),
        "context": c.shared_sources / c.requester_sources if c.requester_sources else 0.0,
        "fairness": max(0.0, 1.0 - c.pending_this_week / c.weekly_cap) if c.weekly_cap else 0.0,
    }
    comp = {k: round(min(1.0, max(0.0, v)), 4) for k, v in comp.items()}
    total = round(sum(WEIGHTS[k] * v for k, v in comp.items()), 4)
    return total, comp
