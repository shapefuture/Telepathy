"""The Python nexus.v1 implementation must match the shared conformance vectors."""

import json
from datetime import datetime
from pathlib import Path

import pytest

from telepathy.federation import nexus

V = json.loads(
    (Path(__file__).parents[1] / "contracts/test-vectors/nexus-v1.json").read_text("utf-8")
)
NOW = datetime.fromisoformat(V["now"].replace("Z", "+00:00"))


def test_canonical_and_signature_match_the_worker() -> None:
    assert nexus.canonical(V["message"]) == V["canonical"]
    assert nexus.public_key_of(V["private_key_pkcs8"]) == V["public_key"]
    signed = nexus.sign(V["message"], V["private_key_pkcs8"])
    assert signed["signature"] == V["signature"]  # Ed25519 is deterministic


@pytest.mark.parametrize("case", V["verify_cases"], ids=lambda c: c["note"])
def test_verify_cases(case: dict) -> None:
    msg = {**V["message"], "signature": V["signature"], **case["patch"]}
    assert nexus.verify(msg, V["public_key"]) is case["expect"]


@pytest.mark.parametrize("case", V["shape_cases"], ids=lambda c: c["note"])
def test_shape_cases(case: dict) -> None:
    assert nexus.check_shape({**V["message"], **case["patch"]}, NOW) == case["expect"]


def test_rejects_floats_which_canonical_json_cannot_pin_down() -> None:
    with pytest.raises(TypeError):
        nexus.canonical({"x": 1.5})
