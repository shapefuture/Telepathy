"""Extractive, cited answers (P06-03, P06-04, P06-09).

No generation: we return verbatim snippets with source and date, or abstain. Message
content is treated purely as evidence; nothing inside it is ever executed or obeyed.
"""

from __future__ import annotations

import html
import sqlite3
from dataclasses import dataclass, field
from enum import StrEnum
from zoneinfo import ZoneInfo

from telepathy.domain.text import content_terms, normalize, snippet
from telepathy.domain.types import AccessContext, from_iso
from telepathy.retrieval.search import Hit, search

MIN_COVERAGE = 0.5  # fraction of query content terms an excerpt must contain
MAX_QUOTES = 3


class AnswerStatus(StrEnum):
    ANSWERED = "answered"
    INSUFFICIENT = "insufficient_evidence"
    NO_ACCESS = "no_accessible_sources"
    EMPTY_QUERY = "empty_query"


@dataclass(frozen=True, slots=True)
class Quote:
    excerpt_id: str
    text: str
    event_at: str
    citation_uri: str | None
    coverage: float


@dataclass(frozen=True, slots=True)
class Answer:
    status: AnswerStatus
    query: str
    quotes: list[Quote] = field(default_factory=list)


def _coverage(body: str, terms: list[str]) -> float:
    if not terms:
        return 0.0
    folded = normalize(body)
    # Prefix-tolerant to match FTS prefix search on inflected words.
    hits = sum(1 for t in terms if (t[: max(4, len(t) - 2)] if len(t) >= 6 else t) in folded)
    return hits / len(terms)


def answer(conn: sqlite3.Connection, ctx: AccessContext, query: str) -> Answer:
    query = query.strip()
    terms = content_terms(query)
    if not terms:
        return Answer(AnswerStatus.EMPTY_QUERY, query)
    if not ctx.readable_source_ids:
        return Answer(AnswerStatus.NO_ACCESS, query)
    hits: list[Hit] = search(conn, ctx, query)
    quotes = []
    for h in hits:
        cov = _coverage(h.body, terms)
        if cov >= MIN_COVERAGE:
            quotes.append(
                Quote(h.excerpt_id, snippet(h.body, terms), h.event_at, h.citation_uri, cov)
            )
    quotes.sort(key=lambda q: -q.coverage)  # stable: keeps rank order among ties
    if not quotes:
        return Answer(AnswerStatus.INSUFFICIENT, query)
    return Answer(AnswerStatus.ANSWERED, query, quotes[:MAX_QUOTES])


def render_html(ans: Answer, tz: ZoneInfo) -> str:
    """Telegram HTML. All evidence text is escaped (no markup injection from messages)."""
    if ans.status is AnswerStatus.EMPTY_QUERY:
        return "Usage: <code>/ask your question</code>"
    if ans.status is AnswerStatus.NO_ACCESS:
        return (
            "I don't have any community sources you're allowed to read yet. "
            "Post in an enabled group first, or ask an admin."
        )
    if ans.status is AnswerStatus.INSUFFICIENT:
        return (
            "<b>No reliable answer found</b> in sources you can access.\n"
            "Try different wording, or ask the community directly."
        )
    lines = [
        f"<b>Found {len(ans.quotes)} relevant message(s)</b> — quoted verbatim, "
        "please check the source:"
    ]
    for i, q in enumerate(ans.quotes, 1):
        when = from_iso(q.event_at).astimezone(tz).strftime("%Y-%m-%d")
        src = (
            f'<a href="{html.escape(q.citation_uri, quote=True)}">source</a>'
            if q.citation_uri
            else "source link unavailable"
        )
        lines.append(f"\n{i}. <blockquote>{html.escape(q.text)}</blockquote>\n{when} · {src}")
    return "\n".join(lines)
