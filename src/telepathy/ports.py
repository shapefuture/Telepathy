"""Versioned connector ports (P01-07). Adapters live outside the domain package."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Protocol

from telepathy.domain.classify import Classification
from telepathy.domain.types import Visibility


class Clock(Protocol):
    def now(self) -> datetime: ...


class Embedder(Protocol):
    """embedding.v1 slot. Implementations MUST call EgressGuard before any network I/O."""

    model_id: str
    dimensions: int

    def embed(
        self, texts: Sequence[str], *, input_type: str, visibility: Visibility
    ) -> list[list[float]]: ...


class Classifier(Protocol):
    """classifier.v1 slot. Implementations MUST call EgressGuard before any network I/O."""

    def classify(self, text: str, *, visibility: Visibility) -> Classification: ...


class Notifier(Protocol):
    """Sends one message. Returns a provider reference (e.g. Telegram message_id)."""

    async def send(self, target: str, text: str) -> str: ...
