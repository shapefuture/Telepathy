"""Independent Python implementation agrees with the shared continuity vectors."""

import json
from pathlib import Path

import pytest

from telepathy.federation import continuity as c
from telepathy.federation.nexus import canonical

V = json.loads(
    (Path(__file__).parents[1] / "contracts/test-vectors/continuity-v1.json").read_text("utf-8")
)
ROOT = V["root"]


def test_canonical_root() -> None:
    assert canonical(ROOT["signed"]) == V["canonical_root"]


@pytest.mark.parametrize("case", V["cases"]["root"], ids=lambda x: x["note"])
def test_root(case: dict) -> None:
    assert c.verify_root(case["doc"], case["trusted"], V["now"]) == case["expect"]


@pytest.mark.parametrize("case", V["cases"]["destinations"], ids=lambda x: x["note"])
def test_destinations(case: dict) -> None:
    assert c.verify_destinations(case["doc"], ROOT, case["last"], V["now"]) == case["expect"]


@pytest.mark.parametrize("case", V["cases"]["pass"], ids=lambda x: x["note"])
def test_pass(case: dict) -> None:
    assert c.verify_pass(case["doc"], ROOT, case["me"], V["now"]) is case["expect"]


def test_restore_is_order_independent_and_newest_wins() -> None:
    older, newer = V["cases"]["restore"]["exports"]
    assert all(c.verify_export(b, ROOT) for b in (older, newer))
    want = V["cases"]["restore"]["expect_any_order"]
    assert c.follow_state_from([older, newer]) == want
    assert c.follow_state_from([newer, older]) == want
    assert want["ann@example.com|news"] == "unfollowed"


def test_tampered_export_fails() -> None:
    _, newer = V["cases"]["restore"]["exports"]
    bad = {**newer, "signed": {**newer["signed"], "org": "club-a", "people": []}}
    assert not c.verify_export(bad, ROOT)
