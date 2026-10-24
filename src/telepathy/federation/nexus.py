"""nexus.v1 messages in Python, written from the spec, not from the Worker's code.

It is the second implementation the conformance gate asks for: it must reproduce the canonical
form and signatures in ``contracts/test-vectors/nexus-v1.json`` and reject the same malformed
messages. Canonical JSON follows ECMAScript ``JSON.stringify`` for the values the protocol uses
(strings, integers, booleans, null, arrays, objects): sorted keys, no whitespace, UTF-8.
"""

from __future__ import annotations

import base64
import json
import re
from datetime import datetime, timedelta
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

SCHEMA = "nexus.v1"
TYPES = ("inquiry", "offer", "decline", "approval", "commitment", "withdraw")
ENVELOPE_FIELDS = ("job", "summary", "criteria")
INQUIRY_KEYS = {
    "mission_ref",
    "job",
    "summary",
    "criteria",
    "allowed_fields",
    "purpose",
    "forwarding",
    "max_hops",
    "policy_version",
}
MAX_TTL = timedelta(days=15)
CLOCK_SKEW = timedelta(minutes=5)


def canonical(value: Any) -> str:
    if isinstance(value, dict):
        items = sorted(value.items())
        return "{" + ",".join(f"{_s(k)}:{canonical(v)}" for k, v in items) + "}"
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, bool) or value is None:
        return json.dumps(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return _s(value)
    raise TypeError(f"nexus.v1 allows no {type(value).__name__} values")


def _s(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


def _unsigned(msg: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in msg.items() if k != "signature"}


def sign(msg: dict[str, Any], private_key_pkcs8_b64: str) -> dict[str, Any]:
    key = serialization.load_der_private_key(base64.b64decode(private_key_pkcs8_b64), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("not an Ed25519 key")
    rest = _unsigned(msg)
    sig = key.sign(canonical(rest).encode())
    return {**rest, "signature": base64.b64encode(sig).decode()}


def verify(msg: dict[str, Any], public_key_b64: str) -> bool:
    sig = msg.get("signature")
    if not isinstance(sig, str):
        return False
    try:
        key = Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key_b64))
        key.verify(base64.b64decode(sig), canonical(_unsigned(msg)).encode())
        return True
    except (InvalidSignature, ValueError):
        return False


def public_key_of(private_key_pkcs8_b64: str) -> str:
    key = serialization.load_der_private_key(base64.b64decode(private_key_pkcs8_b64), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("not an Ed25519 key")
    raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(raw).decode()


def _time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def check_shape(msg: Any, now: datetime) -> str | None:
    """Reason code for a malformed message, or None. Same codes as the Worker."""
    if not isinstance(msg, dict):
        return "not_object"
    if msg.get("schema") != SCHEMA:
        return "schema"
    if msg.get("type") not in TYPES:
        return "type"
    for k in ("exchange_id", "issuer_org", "recipient_org", "issued_at", "expires_at", "nonce"):
        v = msg.get(k)
        if not isinstance(v, str) or not v or len(v) > 200:
            return f"field:{k}"
    body = msg.get("body")
    if not isinstance(body, dict):
        return "body"
    issued, expires = _time(msg["issued_at"]), _time(msg["expires_at"])
    if issued is None or expires is None:
        return "time"
    if issued > now + CLOCK_SKEW:
        return "future"
    if expires <= now:
        return "expired"
    if expires - issued > MAX_TTL:
        return "ttl"
    if msg["type"] == "inquiry":
        return _check_inquiry(body)
    return None


def _check_inquiry(b: dict[str, Any]) -> str | None:
    for k in b:
        if k not in INQUIRY_KEYS:
            return f"inquiry_field:{k}"
    if b.get("forwarding") != "prohibited" or b.get("max_hops") != 1:
        return "forwarding"
    if b.get("purpose") != "evaluate_willing_provider":
        return "purpose"
    job = b.get("job")
    if not isinstance(job, str) or not re.fullmatch(r"[a-z0-9_.]{2,80}", job):
        return "job"
    summary = b.get("summary")
    if not isinstance(summary, str) or not summary or len(summary) > 600:
        return "summary"
    if not isinstance(b.get("mission_ref"), str) or not b["mission_ref"]:
        return "mission_ref"
    fields = b.get("allowed_fields")
    if not isinstance(fields, list) or any(f not in ENVELOPE_FIELDS for f in fields):
        return "allowed_fields"
    if "criteria" in b and not isinstance(b["criteria"], dict):
        return "criteria"
    return None
