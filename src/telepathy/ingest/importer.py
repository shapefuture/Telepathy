"""Telegram Desktop export importer (P03-06).

Imports `result.json` from "Export chat history" into an already-enabled source. Run by
the operator on the host (CLI), never via an upload endpoint. Each imported message
goes through the same idempotent `ingest` path as live updates, so re-running an import
is safe and live/imported copies of a message dedupe.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from telepathy.ingest.normalize import normalize_message
from telepathy.ingest.service import IngestOutcome, get_enabled_source, ingest


@dataclass
class ImportReport:
    seen: int = 0
    outcomes: dict[str, int] = field(default_factory=dict)


def _text(value: Any) -> str:
    """Export `text` is a string or a mixed array of strings and entity objects."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(v if isinstance(v, str) else str(v.get("text", "")) for v in value)
    return ""


def _user_id(from_id: Any) -> int | None:
    if isinstance(from_id, str) and from_id.startswith("user"):
        try:
            return int(from_id[4:])
        except ValueError:
            return None
    return None


def bot_api_chat_id(export: dict[str, Any]) -> int:
    """Desktop exports store supergroup IDs without the -100 prefix."""
    raw = int(export["id"])
    if raw < 0:
        return raw
    if export.get("type") in (
        "private_supergroup",
        "public_supergroup",
        "private_channel",
        "public_channel",
    ):
        return int(f"-100{raw}")
    return -raw


def to_bot_messages(export: dict[str, Any], chat_id: int) -> Iterator[dict[str, Any]]:
    for m in export.get("messages", []):
        if m.get("type") != "message":
            continue  # service messages (joins, pins) carry no knowledge
        text = _text(m.get("text"))
        if not text.strip():
            continue  # media without caption: files are not in the JSON
        msg: dict[str, Any] = {
            "message_id": int(m["id"]),
            "date": int(m["date_unixtime"]) if m.get("date_unixtime") else m["date"],
            "chat": {"id": chat_id, "type": "supergroup"},
            "text": text,
        }
        uid = _user_id(m.get("from_id"))
        if uid is not None:
            msg["from"] = {"id": uid, "is_bot": False}
        if m.get("edited_unixtime"):
            msg["edit_date"] = int(m["edited_unixtime"])
        if m.get("reply_to_message_id"):
            msg["reply_to_message"] = {"message_id": int(m["reply_to_message_id"])}
        yield msg


def import_export(
    conn: sqlite3.Connection, community_id: str, path: Path, chat_id: int | None = None
) -> ImportReport:
    export = json.loads(path.read_text(encoding="utf-8"))
    cid = chat_id if chat_id is not None else bot_api_chat_id(export)
    if get_enabled_source(conn, community_id, "telegram", cid) is None:
        raise PermissionError(f"chat {cid} is not an enabled source; run /enable there first")
    report = ImportReport()
    for msg in to_bot_messages(export, cid):
        report.seen += 1
        outcome: IngestOutcome = ingest(conn, community_id, normalize_message(msg))
        report.outcomes[outcome.value] = report.outcomes.get(outcome.value, 0) + 1
    return report
