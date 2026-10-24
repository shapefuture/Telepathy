"""Text normalization shared by indexing and querying (P02-05)."""

from __future__ import annotations

import hashlib
import re
import unicodedata

from telepathy.domain.translit import variants

_WORD = re.compile(r"\w+", re.UNICODE)

# Small RU/EN stopword lists: only used for evidence-coverage scoring, never for indexing.
STOPWORDS = frozenset(
    [
        "a",
        "an",
        "the",
        "and",
        "or",
        "of",
        "to",
        "in",
        "on",
        "for",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "it",
        "this",
        "that",
        "with",
        "at",
        "by",
        "from",
        "as",
        "what",
        "who",
        "how",
        "when",
        "where",
        "why",
        "which",
        "can",
        "could",
        "do",
        "does",
        "did",
        "i",
        "you",
        "we",
        "they",
        "he",
        "she",
        "my",
        "your",
        "our",
        "any",
        "anyone",
        "someone",
        "somebody",
        "please",
        "about",
        "there",
        "here",
        "have",
        "has",
        "had",
        "will",
        "would",
        "should",
        "и",
        "в",
        "во",
        "на",
        "с",
        "со",
        "к",
        "ко",
        "по",
        "о",
        "об",
        "от",
        "до",
        "за",
        "из",
        "у",
        "же",
        "ли",
        "не",
        "да",
        "нет",
        "а",
        "но",
        "или",
        "что",
        "кто",
        "как",
        "где",
        "когда",
        "почему",
        "какой",
        "какая",
        "какие",
        "это",
        "этот",
        "эта",
        "мы",
        "вы",
        "они",
        "он",
        "она",
        "я",
        "мне",
        "меня",
        "ты",
        "есть",
        "был",
        "была",
        "были",
        "кто-нибудь",
        "пожалуйста",
        "можно",
        "подскажите",
    ]
)


def normalize(text: str) -> str:
    """NFC + casefold. Used identically for stored bodies and queries."""
    return unicodedata.normalize("NFC", text).casefold()


def tokens(text: str) -> list[str]:
    return _WORD.findall(normalize(text))


def content_terms(text: str) -> list[str]:
    """Distinct non-stopword tokens in order of first appearance."""
    seen: dict[str, None] = {}
    for tok in tokens(text):
        if len(tok) > 1 and tok not in STOPWORDS:
            seen.setdefault(tok, None)
    return list(seen)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def fts_query(text: str, *, prefix: bool = True, translit: bool = True) -> str | None:
    """Build a safe FTS5 MATCH expression (OR of quoted terms and their variants).

    Every term is double-quoted so user input cannot inject FTS5 operators.
    """
    terms = content_terms(text) or [t for t in tokens(text) if len(t) > 1]
    if not terms:
        return None
    expanded: dict[str, None] = {}
    for term in terms[:16]:
        expanded.setdefault(term, None)
        if translit:
            for v in variants(term):
                expanded.setdefault(v, None)
    parts = []
    for term in expanded:
        quoted = '"' + term.replace('"', '""') + '"'
        # Prefix matching helps Russian inflection (e.g. "бухгалтер" ~ "бухгалтера").
        parts.append(quoted + "*" if prefix and len(term) >= 4 else quoted)
    return " OR ".join(parts)


def stem_key(term: str) -> str:
    """Prefix used for inflection-tolerant containment checks."""
    return term[: max(4, len(term) - 2)] if len(term) >= 6 else term


def term_present(term: str, folded_body: str) -> bool:
    """True if the term, or a transliterated spelling of it, appears in the body."""
    return any(stem_key(t) in folded_body for t in (term, *variants(term)))


def snippet(body: str, terms: list[str], width: int = 280) -> str:
    """Verbatim window of the original body around the first matched term."""
    if len(body) <= width:
        return body
    folded = normalize(body)
    pos = min((folded.find(t) for t in terms if folded.find(t) >= 0), default=0)
    start = max(0, pos - width // 3)
    end = min(len(body), start + width)
    start = max(0, end - width)
    out = body[start:end].strip()
    return ("…" if start > 0 else "") + out + ("…" if end < len(body) else "")
