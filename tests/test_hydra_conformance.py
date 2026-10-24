"""Independent Python implementation agrees with the shared Hydra vectors (P16, H8), and a standby
node restores from escrow and finds who to reach without Cloudflare (H4 gate)."""

import base64
import json
from pathlib import Path

import pytest

from telepathy.federation import hydra as h

V = json.loads(
    (Path(__file__).parents[1] / "contracts/test-vectors/hydra-v1.json").read_text("utf-8")
)
ROOT = V["root"]


@pytest.mark.parametrize("case", V["domains"], ids=lambda c: f"{c['kind']}:{c['address']}")
def test_domains(case: dict) -> None:
    o = case["opts"]
    base = h.head_domains(
        case["kind"],
        case["address"],
        mx=o.get("mx"),
        senders=o.get("senders"),
        matrix_server=o.get("matrixServer"),
    )
    assert h.expand_domains(base, {}) == case["expect"]


def test_independence_and_index() -> None:
    for c in V["independent"]:
        assert (
            h.independent_count([h.expand_domains(x, c["registry"]) for x in c["heads"]])
            == c["expect"]
        )
    for c in V["index"]:
        assert h.hydra_index(c["graph"]) == c["expect"]


def test_signed_material() -> None:
    for c in V["notices"]:
        assert h.verify_notice(c["doc"], ROOT) == c["expect"]
    assert all(h.verify_receipt(r, ROOT) for r in V["receipts"]["valid"])
    assert h.verify_receipt(V["receipts"]["forged"], ROOT) is V["receipts"]["forged_valid"]
    assert h.follow_state_from_receipts(V["receipts"]["valid"]) == V["receipts"]["state_from_all"]
    assert h.verify_heartbeat(V["heartbeat"], ROOT)
    assert h.anchor_record(ROOT, V["manifest"]) == V["anchor"]["record"]
    assert h.check_anchor(V["anchor"]["record"], ROOT, V["manifest"]) == V["anchor"]["check"]


def test_escrow_shamir_totp() -> None:
    for r in V["escrow"]["recipients"]:
        assert (
            h.decrypt_escrow(V["escrow"]["envelope"], r["privateKey"]) == V["escrow"]["plaintext"]
        )
    with pytest.raises(ValueError, match="not_a_recipient"):
        h.decrypt_escrow(V["escrow"]["envelope"], base64.b64encode(bytes(32)).decode())
    for combo in V["shamir"]["combos"]:
        assert (
            base64.b64encode(h.shamir_combine([V["shamir"]["shares"][i] for i in combo])).decode()
            == V["shamir"]["secret"]
        )
    with pytest.raises(ValueError):
        h.shamir_combine(V["shamir"]["shares"][:2])
    secret = b"x" * 32
    shares = h.shamir_split(secret, 5, 3)
    assert h.shamir_combine([shares[0], shares[3], shares[4]]) == secret
    for c in V["totp"]["cases"]:
        assert h.totp(V["totp"]["secret_ascii"].encode(), c["step"]) == c["expect"]


def test_standby_restore_without_cloudflare(tmp_path: Path) -> None:
    s = V["standby"]
    bundle = h.load_escrow(s["envelope"], s["key"], ROOT)
    db = str(tmp_path / "standby.db")
    assert h.standby_init(bundle, db) == {"people": 3, "heads": 5}
    # bob unfollowed; carl's email is suppressed but his SMS head isn't.
    assert sorted(map(list, h.standby_targets(db))) == sorted(s["expect_targets"])
    assert h.standby_notify(db, "We moved", "New address", send=False) == {
        "email": 1,
        "ntfy": 1,
        "sms_unsupported": 1,
    }
    tampered = json.loads(json.dumps(bundle))
    tampered["signed"]["people"][0]["emails"] = ["evil@example.com"]
    assert not h.verify_export(tampered, ROOT)
