from __future__ import annotations

import pytest

from telepathy.domain.egress import (
    EgressDenied,
    EgressGuard,
    EgressRequest,
    ProviderApproval,
    redact,
)
from telepathy.domain.types import Visibility as V


def req(vis: V, text: str = "hello", synthetic: bool = False) -> EgressRequest:
    return EgressRequest("nvidia_nim", "embedding.passage", vis, text, synthetic)


@pytest.mark.parametrize("vis", list(V))
def test_default_denies_all_real_content(vis):
    with pytest.raises(EgressDenied):
        EgressGuard().check(req(vis))


def test_synthetic_allowed_but_redacted():
    out = EgressGuard().check(req(V.PRIVATE_UNKNOWN, "mail me a@b.io", synthetic=True))
    assert out == "mail me [EMAIL]"


@pytest.mark.parametrize("vis", [V.PRIVATE_UNKNOWN, V.INTERNAL_RESTRICTED])
def test_restricted_never_leaves_even_with_approval(vis):
    approval = ProviderApproval("nvidia_nim", "embedding.passage", frozenset(V), "DPA-1")
    with pytest.raises(EgressDenied):
        EgressGuard([approval]).check(req(vis))


def test_approval_is_scoped_to_provider_purpose_visibility():
    approval = ProviderApproval(
        "nvidia_nim", "embedding.passage", frozenset({V.PUBLIC_APPROVED}), "DPA-1"
    )
    g = EgressGuard([approval])
    assert g.check(req(V.PUBLIC_APPROVED, "call +1 415 555 0100")) == "call [PHONE]"
    with pytest.raises(EgressDenied):
        g.check(req(V.MEMBER_CONSENTED))
    with pytest.raises(EgressDenied):
        g.check(EgressRequest("other", "embedding.passage", V.PUBLIC_APPROVED, "x"))


@pytest.mark.parametrize(
    "secret",
    [
        "token 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ",
        "key nvapi-abcdefghijklmnopqrstuvwxyz",
        "password: hunter2",
        "-----BEGIN RSA PRIVATE KEY-----",
    ],
)
def test_credentials_block_even_synthetic(secret):
    with pytest.raises(EgressDenied):
        EgressGuard().check(req(V.PUBLIC_APPROVED, secret, synthetic=True))


def test_redaction_patterns():
    s = redact("ping @alice_dev or https://x.io/a?token=abc and https://ok.io/page")
    assert s == "ping [HANDLE] or [URL_WITH_SECRET] and [URL]"


def test_size_cap():
    with pytest.raises(EgressDenied):
        EgressGuard(max_chars=10).check(req(V.PUBLIC_APPROVED, "x" * 11, synthetic=True))
