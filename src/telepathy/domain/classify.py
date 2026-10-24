"""Deterministic fallback classifier (P04-09).

Used when the external classifier is unavailable or egress is denied. It only flags
explicit phrasing; anything unclear is 'other' with low confidence and is never promoted.
A label is never evidence of competence (C08).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

from telepathy.domain.text import normalize


class Intent(StrEnum):
    HELP_REQUEST = "help_request"
    ANSWER_CANDIDATE = "answer_candidate"
    HELP_OFFER = "help_offer"
    EVENT = "event"
    RESOURCE = "resource"
    DECISION = "decision"
    SOCIAL = "social"
    OTHER = "other"


class Route(StrEnum):
    PRIVATE_SUGGESTION = "private_suggestion"  # p >= 0.80
    REVIEW = "review"  # 0.50 <= p < 0.80
    DISCARD = "discard"  # p < 0.50


@dataclass(frozen=True, slots=True)
class Classification:
    intent: Intent
    confidence: float
    source: str  # "rules" | provider model id

    @property
    def route(self) -> Route:
        return route_for(self.confidence)


def route_for(p: float, *, high: float = 0.80, low: float = 0.50) -> Route:
    """P04-07 thresholds. Non-finite/out-of-range values are discarded."""
    if not (0.0 <= p <= 1.0):
        return Route.DISCARD
    if p >= high:
        return Route.PRIVATE_SUGGESTION
    if p >= low:
        return Route.REVIEW
    return Route.DISCARD


def _rx(*patterns: str) -> re.Pattern[str]:
    return re.compile("|".join(patterns), re.IGNORECASE | re.UNICODE)


_HELP_REQUEST = _rx(
    r"\b(can|could) (anyone|someone|somebody|you) (recommend|help|suggest|advise)",
    r"\b(looking for|need) (a|an|some)? ?(recommendation|advice|help|contact|intro)",
    r"\bdoes anyone know\b",
    r"\bany recommendations?\b",
    r"\bwho (knows|can)\b",
    r"\bпосоветуйте\b",
    r"\bподскажите\b",
    r"\bкто[- ]?(нибудь|то)? ?(знает|может|подскажет)",
    r"\bищу\b",
    r"\bнужен\b|\bнужна\b|\bнужно\b",
    r"\bпомогите\b",
)
_HELP_OFFER = _rx(
    r"\bi can help\b",
    r"\bhappy to help\b",
    r"\bfeel free to (dm|reach out|ping)",
    r"\bмогу помочь\b",
    r"\bготов[аы]? помочь\b",
    r"\bобращайтесь\b",
    r"\bпишите в лс\b",
)
_EVENT = _rx(
    r"\b(meetup|webinar|workshop|event|meeting) (on|at|this|next)\b",
    r"\bjoin us\b",
    r"\bвстреча\b",
    r"\bвебинар\b",
    r"\bмитап\b",
    r"\bприглашаем\b",
)
_SOCIAL = _rx(r"^(hi|hello|hey|thanks|thank you|привет|спасибо|всем привет)\b[\s!.]*$")
_URL = re.compile(r"https?://\S+")


def classify_rules(text: str) -> Classification:
    t = normalize(text).strip()
    if not t:
        return Classification(Intent.OTHER, 0.0, "rules")
    if _HELP_REQUEST.search(t):
        conf = 0.85 if "?" in t else 0.70
        return Classification(Intent.HELP_REQUEST, conf, "rules")
    if _HELP_OFFER.search(t):
        return Classification(Intent.HELP_OFFER, 0.80, "rules")
    if _EVENT.search(t):
        return Classification(Intent.EVENT, 0.70, "rules")
    if _SOCIAL.search(t):
        return Classification(Intent.SOCIAL, 0.80, "rules")
    if _URL.search(t):
        return Classification(Intent.RESOURCE, 0.55, "rules")
    if t.endswith("?"):
        # A bare question is plausible but unclear: review only, never auto-promoted.
        return Classification(Intent.HELP_REQUEST, 0.55, "rules")
    return Classification(Intent.OTHER, 0.30, "rules")
