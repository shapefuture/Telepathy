"""Continuity verification in Python, independent of the Worker and of Nexus (CONT-5, CONT-10).

A club (or anyone it trusts) can, with only this file and a pinned root:
  * check the club's root, address lists and relocations (`verify`);
  * rebuild who still wants which notices from one or more exports, in any order (`restore`).

    python -m telepathy.federation.continuity verify community.json [pinned-root.json]
    python -m telepathy.federation.continuity restore pinned-root.json export1.json [...]

Rules match ``worker/src/continuity/identity.ts`` and the vectors in
``contracts/test-vectors/continuity-v1.json``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from telepathy.federation.nexus import canonical

Doc = dict[str, Any]
Verdict = dict[str, Any]
KINDS = ("web", "telegram", "rss", "matrix", "email_list", "portal")
URL = re.compile(r"(https://|tg://)\S{3,300}")


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def key_id(public_key_b64: str) -> str:
    return hashlib.sha256(base64.b64decode(public_key_b64)).hexdigest()[:16]


def count_valid(doc: Doc, keys: list[dict[str, str]]) -> int:
    data = canonical(doc["signed"]).encode()
    ok: set[str] = set()
    for s in doc.get("signatures") or []:
        k = next((x for x in keys if x.get("keyid") == s.get("keyid")), None)
        if k is None or k["keyid"] in ok:
            continue
        try:
            Ed25519PublicKey.from_public_bytes(base64.b64decode(k["key"])).verify(
                base64.b64decode(s["sig"]), data
            )
            ok.add(k["keyid"])
        except (InvalidSignature, ValueError, KeyError):
            continue
    return len(ok)


def _bad(reason: str) -> Verdict:
    return {"ok": False, "reason": reason}


def verify_root(doc: Doc, trusted: Doc | None, now: str | None = None) -> Verdict:
    now = now or _now()
    r = doc.get("signed") if isinstance(doc, dict) else None
    if (
        not isinstance(r, dict)
        or r.get("schema") != "nexus.root.v1"
        or not isinstance(r.get("version"), int)
        or r["version"] < 1
        or not isinstance(r.get("root_keys"), list)
        or not isinstance(r.get("online_keys"), list)
        or not isinstance(r.get("threshold"), int)
        or not 1 <= r["threshold"] <= len(r["root_keys"])
    ):
        return _bad("root_shape")
    if any(k.get("keyid") != key_id(k.get("key", "")) for k in r["root_keys"] + r["online_keys"]):
        return _bad("root_keyid")
    if r["expires"] <= now:
        return _bad("root_expired")
    if count_valid(doc, r["root_keys"]) < r["threshold"]:
        return _bad("root_threshold")
    if trusted:
        t = trusted["signed"]
        if r["org"] != t["org"]:
            return _bad("root_org")
        if r["version"] < t["version"]:
            return _bad("root_rollback")
        if r["version"] == t["version"]:
            return {"ok": True} if canonical(r) == canonical(t) else _bad("root_fork")
        if r["version"] != t["version"] + 1:
            return _bad("root_skip")
        if count_valid(doc, t["root_keys"]) < t["threshold"]:
            return _bad("root_not_authorized_by_previous")
    return {"ok": True}


def _primary(d: dict[str, Any] | None) -> str | None:
    if not d:
        return None
    return next((x["url"] for x in d["destinations"] if x.get("role") == "primary"), None)


def _dest_shape(d: Any) -> bool:
    if not isinstance(d, dict) or d.get("schema") != "nexus.destinations.v1":
        return False
    if not isinstance(d.get("version"), int) or d["version"] < 1:
        return False
    ds = d.get("destinations")
    if (
        not isinstance(ds, list)
        or len(ds) > 20
        or sum(1 for x in ds if x.get("role") == "primary") != 1
    ):
        return False
    return all(
        x.get("kind") in KINDS
        and x.get("role") in ("primary", "backup")
        and isinstance(x.get("url"), str)
        and URL.fullmatch(x["url"])
        for x in ds
    )


def verify_destinations(doc: Doc, root: Doc, last: Doc | None, now: str | None = None) -> Verdict:
    now = now or _now()
    d = doc.get("signed") if isinstance(doc, dict) else None
    if not _dest_shape(d):
        return _bad("dest_shape")
    assert isinstance(d, dict)
    r = root["signed"]
    if d["org"] != r["org"]:
        return _bad("dest_org")
    if d["root_version"] != r["version"]:
        return _bad("dest_root_version")
    if d["expires"] <= now:
        return _bad("dest_expired")
    if last:
        lv = last["signed"]["version"]
        if d["version"] < lv:
            return _bad("dest_rollback")
        if d["version"] == lv:
            return {"ok": True} if canonical(d) == canonical(last["signed"]) else _bad("dest_fork")
    moved = bool(last) and _primary(d) != _primary(last["signed"] if last else None)
    reloc = d.get("relocation")
    if moved or reloc:
        if (
            not reloc
            or reloc.get("to") != _primary(d)
            or (last and reloc.get("from") != _primary(last["signed"]))
        ):
            return _bad("relocation_record")
        if count_valid(doc, r["root_keys"]) < r["threshold"]:
            return _bad("relocation_needs_root")
        return {"ok": True, "relocation": True}
    if count_valid(doc, r["online_keys"]) < 1 and count_valid(doc, r["root_keys"]) < r["threshold"]:
        return _bad("dest_signature")
    return {"ok": True, "relocation": False}


def verify_pass(doc: Doc, issuer_root: Doc, me: str, now: str | None = None) -> bool:
    now = now or _now()
    c = doc.get("signed") or {}
    return (
        c.get("schema") == "nexus.attestation.v1"
        and c.get("org") == issuer_root["signed"]["org"]
        and c.get("audience") == me
        and c.get("expires_at", "") > now
        and count_valid(doc, issuer_root["signed"]["online_keys"]) >= 1
    )


def follow_state_from(bundles: list[Doc]) -> dict[str, str]:
    """Who wants what, from exports in any order: the highest sequence per (email, topic) wins."""
    best: dict[str, tuple[int, str]] = {}
    for b in bundles:
        for p in b["signed"]["people"]:
            for o in p["ops"]:
                if not o.get("topic") or o["op"] == "REVOKE_ENDPOINT":
                    continue
                status = {"FOLLOW": "following", "UNMUTE": "following", "MUTE": "muted"}.get(
                    o["op"], "unfollowed"
                )
                for e in p["emails"]:
                    k = f"{e.lower()}|{o['topic']}"
                    if k not in best or best[k][0] < o["seq"]:
                        best[k] = (o["seq"], status)
    return {k: v[1] for k, v in best.items()}


def verify_export(bundle: Doc, root: Doc) -> bool:
    s = bundle.get("signed") or {}
    return (
        s.get("schema") == "nexus.continuity-export.v1"
        and s.get("org") == root["signed"]["org"]
        and (
            count_valid(bundle, root["signed"]["online_keys"]) >= 1
            or count_valid(bundle, root["signed"]["root_keys"]) >= root["signed"]["threshold"]
        )
    )


def _load(path: str) -> Doc:
    data: Doc = json.loads(Path(path).read_text("utf-8"))
    return data


def main(argv: list[str]) -> int:
    load = _load
    if len(argv) >= 2 and argv[0] == "verify":
        community = load(argv[1])
        pinned = load(argv[2]) if len(argv) > 2 else None
        root = community["root"]
        v = verify_root(root, pinned)
        print("root:", v)
        if v["ok"] and community.get("destinations"):
            print("destinations:", verify_destinations(community["destinations"], root, None))
        return 0 if v["ok"] else 1
    if len(argv) >= 3 and argv[0] == "restore":
        root = load(argv[1])
        bundles = [load(p) for p in argv[2:]]
        if not all(verify_export(b, root) for b in bundles):
            print("an export failed signature verification", file=sys.stderr)
            return 1
        for key, state in sorted(follow_state_from(bundles).items()):
            print(f"{key}\t{state}")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
