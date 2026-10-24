"""Outbound model-egress membrane (C03, C14, P04-02, P04-03, P05-04).

Deny by default. Any call to an external model provider must pass `EgressGuard.check`
and send only the *returned* redacted text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from telepathy.domain.types import Visibility


class EgressDenied(Exception):
    """Raised when content may not leave the host. Callers must fall back locally."""


@dataclass(frozen=True, slots=True)
class ProviderApproval:
    """A documented, signed authorization for one provider + purpose (QG09).

    No approval exists by default; trial providers are synthetic-only.
    """

    provider: str
    purpose: str
    allowed_visibilities: frozenset[Visibility]
    reference: str  # e.g. link/ID of the signed agreement; never a secret


@dataclass(frozen=True, slots=True)
class EgressRequest:
    provider: str
    purpose: str  # "embedding.passage" | "embedding.query" | "classification"
    visibility: Visibility
    text: str
    synthetic: bool = False


_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE = re.compile(r"(?<!\w)\+?\d[\d\s().-]{7,}\d(?!\w)")
_HANDLE = re.compile(r"(?<![\w@])@[A-Za-z][A-Za-z0-9_]{3,31}\b")
_URL = re.compile(r"https?://\S+")
_URL_SECRET = re.compile(r"[?&](token|key|secret|sig|signature|auth|password|code)=", re.I)
# Credentials: block outright rather than redact (cannot be sure redaction is complete).
_CREDENTIAL = re.compile(
    r"(\b\d{8,10}:[A-Za-z0-9_-]{35}\b"  # Telegram bot token
    r"|\bnvapi-[A-Za-z0-9_-]{20,}"  # NVIDIA key
    r"|\bsk-[A-Za-z0-9]{20,}"  # generic API key shape
    r"|\bAKIA[0-9A-Z]{16}\b"  # AWS access key
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|\b(password|пароль)\s*[:=]\s*\S+)",
    re.I,
)


def redact(text: str) -> str:
    """Pseudonymize identifiers. Raises EgressDenied for credential-like content."""
    if _CREDENTIAL.search(text):
        raise EgressDenied("credential-like content cannot be sanitized")

    def _url(m: re.Match[str]) -> str:
        return "[URL_WITH_SECRET]" if _URL_SECRET.search(m.group(0)) else "[URL]"

    out = _URL.sub(_url, text)
    out = _EMAIL.sub("[EMAIL]", out)
    out = _PHONE.sub("[PHONE]", out)
    out = _HANDLE.sub("[HANDLE]", out)
    return out


@dataclass
class EgressGuard:
    approvals: list[ProviderApproval] = field(default_factory=list)
    max_chars: int = 1200  # P04-05 state cap

    def check(self, req: EgressRequest) -> str:
        """Return the only text allowed to leave, or raise EgressDenied."""
        if req.synthetic:
            # Synthetic fixtures may use trial providers, but still never carry secrets.
            text = redact(req.text)
        else:
            if req.visibility in (Visibility.PRIVATE_UNKNOWN, Visibility.INTERNAL_RESTRICTED):
                raise EgressDenied(f"{req.visibility} content never leaves the host")
            if not any(
                a.provider == req.provider
                and a.purpose == req.purpose
                and req.visibility in a.allowed_visibilities
                for a in self.approvals
            ):
                raise EgressDenied(
                    f"no approval for provider={req.provider} purpose={req.purpose} "
                    f"visibility={req.visibility}"
                )
            text = redact(req.text)
        if len(text) > self.max_chars:
            raise EgressDenied(f"payload exceeds {self.max_chars} chars; segment first")
        return text
