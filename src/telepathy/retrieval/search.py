"""Hybrid retrieval core (P05-07, P05-08, P05-09, P06-02).

Authorization is applied *inside* the candidate query (source_id IN readable set), so
hidden evidence is never scored, ranked or snippeted. Semantic search plugs into
`fuse` once an approved embedder exists; until then lexical FTS5 is the honest fallback.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass

from telepathy.domain.text import fts_query, sha256_hex
from telepathy.domain.types import AccessContext

LEXICAL_TOP_K = 40
SEMANTIC_TOP_K = 40
RRF_K = 60
EVIDENCE_LIMIT = 30


@dataclass(frozen=True, slots=True)
class Hit:
    excerpt_id: str
    source_id: str
    body: str
    event_at: str
    citation_uri: str | None
    score: float


def lexical_candidates(
    conn: sqlite3.Connection, ctx: AccessContext, query: str, *, limit: int = LEXICAL_TOP_K
) -> list[str]:
    """FTS5 top-k excerpt IDs restricted to sources the caller can read."""
    match = fts_query(query)
    if match is None or not ctx.readable_source_ids:
        return []
    rows = conn.execute(
        """
        SELECT e.id
        FROM excerpts_fts f
        JOIN excerpts e ON e.rowid = f.rowid
        WHERE excerpts_fts MATCH ?
          AND e.valid_to IS NULL
          AND e.source_id IN (SELECT value FROM json_each(?))
        ORDER BY bm25(excerpts_fts)
        LIMIT ?
        """,
        (match, json.dumps(sorted(ctx.readable_source_ids)), limit),
    ).fetchall()
    return [r["id"] for r in rows]


def fuse(ranked_lists: Sequence[Sequence[str]], *, k: int = RRF_K) -> list[tuple[str, float]]:
    """Reciprocal rank fusion. Deterministic tie-break on ID."""
    scores: dict[str, float] = {}
    for ranking in ranked_lists:
        for rank, item in enumerate(ranking, start=1):
            scores[item] = scores.get(item, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))


def verify_citations(
    conn: sqlite3.Connection, ctx: AccessContext, scored: Sequence[tuple[str, float]]
) -> list[Hit]:
    """Re-check each candidate right before display (C02, C06, C07).

    Drops anything that is stale, from an unreadable/disabled source, or whose body no
    longer matches its recorded hash.
    """
    if not scored or not ctx.readable_source_ids:
        return []
    ids = [s[0] for s in scored]
    rows = conn.execute(
        """
        SELECT e.id, e.source_id, e.body, e.event_at, e.citation_uri, e.content_sha256
        FROM excerpts e JOIN sources s ON s.id = e.source_id
        WHERE e.id IN (SELECT value FROM json_each(?))
          AND e.valid_to IS NULL AND s.enabled = 1 AND s.community_id = ?
        """,
        (json.dumps(ids), ctx.community_id),
    ).fetchall()
    by_id = {r["id"]: r for r in rows}
    out: list[Hit] = []
    for excerpt_id, score in scored:
        r = by_id.get(excerpt_id)
        if r is None or r["source_id"] not in ctx.readable_source_ids:
            continue
        if sha256_hex(r["body"]) != r["content_sha256"]:
            continue
        out.append(Hit(r["id"], r["source_id"], r["body"], r["event_at"], r["citation_uri"], score))
    return out


def search(
    conn: sqlite3.Connection,
    ctx: AccessContext,
    query: str,
    *,
    semantic: Sequence[str] | None = None,
    limit: int = EVIDENCE_LIMIT,
) -> list[Hit]:
    """Lexical (+ optional pre-authorized semantic) -> RRF -> verified evidence."""
    lists: list[Sequence[str]] = [lexical_candidates(conn, ctx, query)]
    if semantic:
        lists.append(list(semantic)[:SEMANTIC_TOP_K])
    return verify_citations(conn, ctx, fuse(lists)[:limit])
