"""Outbox payload helpers. Payloads are delivered by the bot's notifier."""

from __future__ import annotations

from typing import Any

Button = tuple[str, str]  # (label, callback_data)


def payload(
    chat_id: int,
    text: str,
    buttons: list[list[Button]] | None = None,
    *,
    reveal_tg_id: int | None = None,
) -> dict[str, Any]:
    """`reveal_tg_id`: the notifier appends a live contact link for that user. Contact
    data is resolved at send time and never stored."""
    p: dict[str, Any] = {"chat_id": chat_id, "text": text}
    if buttons:
        p["buttons"] = [[list(b) for b in row] for row in buttons]
    if reveal_tg_id is not None:
        p["reveal_tg_id"] = reveal_tg_id
    return p
