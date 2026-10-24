"""Hydra in Python (P16, H4 and H8): the parts a club needs when Telepathy itself is gone.

Independent of the Worker. Same rules as ``worker/src/hydra/*`` and the vectors in
``contracts/test-vectors/hydra-v1.json``.

    # rebuild the CONTINUITY_KEY (or any secret) from k custodian shares
    python -m telepathy.federation.hydra shamir-combine s1-3-1-... s1-3-4-... s1-3-5-...
    # decrypt a nightly escrow copy and check it against the pinned club root
    python -m telepathy.federation.hydra escrow-decrypt escrow.json x25519.key root.json > out.json
    # yearly drill / real outage: a standby node on any VPS, no Cloudflare involved
    python -m telepathy.federation.hydra standby-init escrow.json x25519.key root.json standby.db
    python -m telepathy.federation.hydra standby-notify standby.db "We moved" "New: ..." [--send]
    # check an anchor record (DNS TXT, a post, a printed card) against a community document
    python -m telepathy.federation.hydra anchor-check anchor.txt community.json
    # hydra index of a head graph (JSON list of {id, heads, buddies})
    python -m telepathy.federation.hydra index graph.json

``standby-notify`` reaches email (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM) and
ntfy heads, only for people who follow critical notices and only on addresses that aren't
suppressed. It prints counts; it sends only with ``--send``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import itertools
import json
import os
import re
import smtplib
import sqlite3
import struct
import sys
import urllib.request
from email.message import EmailMessage
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from telepathy.federation.continuity import count_valid, key_id, verify_export
from telepathy.federation.nexus import canonical

Doc = dict[str, Any]

# ---- failure domains (H0) ------------------------------------------------------------------------

MAIL = {
    "gmail.com": "google", "googlemail.com": "google",
    "outlook.com": "microsoft", "hotmail.com": "microsoft",
    "live.com": "microsoft", "msn.com": "microsoft",
    "yahoo.com": "yahoo", "aol.com": "yahoo", "ymail.com": "yahoo",
    "icloud.com": "apple", "me.com": "apple", "mac.com": "apple",
    "proton.me": "proton", "protonmail.com": "proton", "pm.me": "proton",
    "yandex.ru": "yandex", "ya.ru": "yandex", "yandex.com": "yandex",
    "mail.ru": "vk", "bk.ru": "vk", "inbox.ru": "vk", "list.ru": "vk",
    "gmx.de": "united_internet", "gmx.net": "united_internet", "web.de": "united_internet",
    "fastmail.com": "fastmail", "tutanota.com": "tuta", "tuta.io": "tuta", "zoho.com": "zoho",
}  # fmt: skip
MX = [
    (r"(google\.com|googlemail\.com)\.?$", "google"),
    (r"(outlook\.com|office365\.us)\.?$", "microsoft"),
    (r"(yahoodns\.net)\.?$", "yahoo"),
    (r"(icloud\.com)\.?$", "apple"),
    (r"(protonmail\.ch)\.?$", "proton"),
    (r"(yandex\.(ru|net))\.?$", "yandex"),
    (r"(mail\.ru)\.?$", "vk"),
    (r"(messagingengine\.com)\.?$", "fastmail"),
    (r"(zoho\.(com|eu))\.?$", "zoho"),
]
PUSH = [
    (r"(^|\.)googleapis\.com$", "google"),
    (r"(^|\.)mozilla\.com$", "mozilla"),
    (r"(^|\.)push\.apple\.com$", "apple"),
    (r"(^|\.)notify\.windows\.com$", "microsoft"),
]
ORG_PARENT = {
    "google": "org:google",
    "microsoft": "org:microsoft",
    "apple": "org:apple",
    "yahoo": "org:yahoo",
}


def _host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "unknown").lower()
    except ValueError:
        return "unknown"


def head_domains(
    kind: str,
    address: str,
    mx: str | None = None,
    senders: list[str] | None = None,
    matrix_server: str | None = None,
) -> list[str]:
    out: list[str] = []
    if kind == "telegram":
        out.append("telegram")
    elif kind == "email":
        d = address.strip().lower().split("@")[1] if "@" in address else ""
        op = MAIL.get(d)
        if not op and mx:
            op = next((o for pat, o in MX if re.search(pat, mx.lower())), None)
        out.append(f"mail:{op or d or 'unknown'}")
        if senders and len(senders) == 1:
            out.append(f"sender:{senders[0]}")
    elif kind == "webpush":
        out.append(
            f"push:{next((o for pat, o in PUSH if re.search(pat, _host(address))), 'unknown')}"
        )
    elif kind == "ntfy":
        out.append(f"ntfy:{_host(address)}")
    elif kind == "matrix":
        out.append("matrix:" + ":".join(address.split(":")[1:]).lower())
        if matrix_server:
            out.append(f"matrix:{_host(matrix_server)}")
    elif kind == "sms":
        out.append("sms")
    return list(dict.fromkeys(out))


def expand_domains(base: list[str], registry: dict[str, list[str]] | None = None) -> list[str]:
    reg = registry or {}
    out: set[str] = set()
    stack = list(base)
    while stack:
        d = stack.pop()
        if d in out:
            continue
        out.add(d)
        m = re.match(r"^(mail|push):(.+)$", d)
        if m and m.group(2) in ORG_PARENT:
            stack.append(ORG_PARENT[m.group(2)])
        stack.extend(reg.get(d, []))
    return sorted(out)


def independent_count(heads: list[list[str]]) -> int:
    seen: set[str] = set()
    hs: list[list[str]] = []
    for h in heads:
        k = "|".join(sorted(h))
        if k not in seen:
            seen.add(k)
            hs.append(h)
    hs = hs[:12]
    best = 0
    for r in range(len(hs), 0, -1):
        for combo in itertools.combinations(hs, r):
            flat = [d for h in combo for d in h]
            if len(flat) == len(set(flat)):
                return r
    return best


def hydra_index(graph: list[Doc], threshold: float = 0.1, max_k: int = 4) -> Doc:
    total = len(graph)
    if not total:
        return {"index": 0, "atLeast": False, "worst": [], "cutOff": 0, "people": 0}
    freq: dict[str, int] = {}
    for p in graph:
        for h in p["heads"]:
            for d in h:
                freq[d] = freq.get(d, 0) + 1
    domains = [d for d, _ in sorted(freq.items(), key=lambda kv: (-kv[1], kv[0]))][:24]
    idx = {p["id"]: i for i, p in enumerate(graph)}
    people = [
        ([set(h) for h in p["heads"]], [idx[b] for b in p.get("buddies", []) if b in idx])
        for p in graph
    ]

    def cut(failed: set[str]) -> int:
        direct = [any(not (h & failed) for h in heads) for heads, _ in people]
        return sum(
            1
            for i, (_, bs) in enumerate(people)
            if not direct[i] and not any(direct[b] for b in bs)
        )

    limit = total * threshold
    zero = cut(set())
    if zero > limit:
        return {"index": 0, "atLeast": False, "worst": [], "cutOff": zero, "people": total}
    for k in range(1, min(max_k, len(domains)) + 1):
        for combo in itertools.combinations(range(len(domains)), k):
            failed = {domains[i] for i in combo}
            n = cut(failed)
            if n > limit:
                return {
                    "index": k,
                    "atLeast": False,
                    "worst": [domains[i] for i in combo],
                    "cutOff": n,
                    "people": total,
                }
    return {
        "index": min(max_k, len(domains)) + 1,
        "atLeast": True,
        "worst": [],
        "cutOff": 0,
        "people": total,
    }


# ---- signed public material ----------------------------------------------------------------------


def _online_or_root(doc: Doc, root: Doc) -> bool:
    r = root["signed"]
    return (
        count_valid(doc, r["online_keys"]) >= 1
        or count_valid(doc, r["root_keys"]) >= r["threshold"]
    )


def verify_notice(doc: Doc, root: Doc) -> Doc:
    n = doc.get("signed") or {}
    if (
        n.get("schema") != "nexus.notice.v1"
        or not isinstance(n.get("seq"), int)
        or not isinstance(n.get("title"), str)
        or not isinstance(n.get("body"), str)
    ):
        return {"ok": False, "reason": "notice_shape"}
    if n.get("org") != root["signed"]["org"]:
        return {"ok": False, "reason": "notice_org"}
    return (
        {"ok": True} if _online_or_root(doc, root) else {"ok": False, "reason": "notice_signature"}
    )


OPS = ("FOLLOW", "UNFOLLOW", "MUTE", "UNMUTE", "REVOKE_ENDPOINT")
TOPICS = ("critical", "events", "requests", "news", "commercial", "partner_offers")


def verify_receipt(doc: Doc, root: Doc) -> bool:
    r = doc.get("signed") or {}
    ok_shape = (
        r.get("schema") == "nexus.follow-receipt.v1"
        and r.get("org") == root["signed"]["org"]
        and isinstance(r.get("seq"), int)
        and r["seq"] >= 1
        and r.get("op") in OPS
        and (r.get("topic") is None or r.get("topic") in TOPICS)
        and isinstance(r.get("person_ref"), str)
    )
    return ok_shape and _online_or_root(doc, root)


def follow_state_from_receipts(receipts: list[Doc]) -> dict[str, str]:
    best: dict[str, tuple[int, str]] = {}
    for r in receipts:
        s = r["signed"]
        if not s.get("topic") or s["op"] == "REVOKE_ENDPOINT":
            continue
        status = {"FOLLOW": "following", "UNMUTE": "following", "MUTE": "muted"}.get(
            s["op"], "unfollowed"
        )
        if s["topic"] not in best or best[s["topic"]][0] < s["seq"]:
            best[s["topic"]] = (s["seq"], status)
    return {k: v[1] for k, v in best.items()}


def verify_heartbeat(doc: Doc, root: Doc) -> bool:
    h = doc.get("signed") or {}
    return (
        h.get("schema") == "nexus.heartbeat.v1"
        and h.get("org") == root["signed"]["org"]
        and count_valid(doc, root["signed"]["online_keys"]) >= 1
    )


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def manifest_hash(m: Doc) -> str:
    return _b64u(hashlib.sha256(canonical(m["signed"]).encode()).digest())


def _primary(m: Doc) -> str | None:
    return next((d["url"] for d in m["signed"]["destinations"] if d["role"] == "primary"), None)


def anchor_record(root: Doc, m: Doc) -> str:
    r = root["signed"]
    keys = ",".join(sorted(k["keyid"] for k in r["root_keys"]))
    man = f"{m['signed']['version']}:{manifest_hash(m)}"
    root_part = f"{r['version']}:{keys}/{r['threshold']}"
    return f"nexus1 org={r['org']} root={root_part} man={man} primary={_primary(m)}"


def check_anchor(rec: str, root: Doc, m: Doc) -> Doc:
    parts = rec.strip().split()
    if not parts or parts[0] != "nexus1":
        return {"ok": False, "reason": "anchor_shape"}
    a = dict(p.split("=", 1) for p in parts[1:] if "=" in p)
    r = root["signed"]
    if a.get("org") != r["org"]:
        return {"ok": False, "reason": "anchor_org"}
    if (
        a.get("root")
        != f"{r['version']}:{','.join(sorted(k['keyid'] for k in r['root_keys']))}/{r['threshold']}"
    ):
        return {"ok": False, "reason": "anchor_root"}
    if a.get("man") != f"{m['signed']['version']}:{manifest_hash(m)}":
        return {"ok": False, "reason": "anchor_manifest"}
    if a.get("primary") != _primary(m):
        return {"ok": False, "reason": "anchor_primary"}
    return {"ok": True}


# ---- escrow (H4) ----------------------------------------------------------------------------


def decrypt_escrow(envelope: Doc, private_key_b64: str) -> str:
    priv = X25519PrivateKey.from_private_bytes(base64.b64decode(private_key_b64))
    rpk = priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    kid = key_id(base64.b64encode(rpk).decode())
    r = next((x for x in envelope["recipients"] if x["kid"] == kid), None)
    if r is None:
        raise ValueError("not_a_recipient")
    epk = base64.b64decode(r["epk"])
    shared = priv.exchange(X25519PublicKey.from_public_bytes(epk))
    kek = HKDF(
        algorithm=hashes.SHA256(), length=32, salt=epk + rpk, info=b"nexus-escrow-v1"
    ).derive(shared)
    dek = AESGCM(kek).decrypt(base64.b64decode(r["iv"]), base64.b64decode(r["wrapped"]), None)
    plain = AESGCM(dek).decrypt(
        base64.b64decode(envelope["iv"]), base64.b64decode(envelope["ct"]), None
    )
    if base64.b64encode(hashlib.sha256(plain).digest()).decode() != envelope["sha256"]:
        raise ValueError("hash_mismatch")
    return plain.decode()


# ---- Shamir over GF(256), polynomial 0x11b -----------------------------------------------

_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x = (_x ^ (_x << 1) ^ (0x11B if _x & 0x80 else 0)) & 0xFF
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _mul(a: int, b: int) -> int:
    return _EXP[_LOG[a] + _LOG[b]] if a and b else 0


def _div(a: int, b: int) -> int:
    return _EXP[(_LOG[a] + 255 - _LOG[b]) % 255] if a else 0


def decode_share(text: str) -> tuple[int, int, bytes]:
    m = re.fullmatch(r"s1-(\d{1,3})-(\d{1,3})-([A-Za-z0-9_-]+)", text.strip())
    if not m:
        raise ValueError("share_shape")
    return int(m.group(1)), int(m.group(2)), _unb64u(m.group(3))


def encode_share(k: int, x: int, y: bytes) -> str:
    return f"s1-{k}-{x}-{_b64u(y)}"


def shamir_combine(shares: list[str]) -> bytes:
    parsed = {x: (k, x, y) for k, x, y in (decode_share(s) for s in shares)}
    items = list(parsed.values())
    if not items or len(items) < items[0][0]:
        raise ValueError("shamir_too_few")
    use = items[: items[0][0]]
    out = bytearray(len(use[0][2]))
    for i in range(len(out)):
        acc = 0
        for _, xa, ya in use:
            num, den = 1, 1
            for _, xb, _ in use:
                if xa != xb:
                    num, den = _mul(num, xb), _mul(den, xa ^ xb)
            acc ^= _mul(ya[i], _div(num, den))
        out[i] = acc
    return bytes(out)


def shamir_split(secret: bytes, n: int, k: int) -> list[str]:
    if k < 2 or n < k or n > 255:
        raise ValueError("shamir_params")
    coeffs = [[b, *os.urandom(k - 1)] for b in secret]
    out = []
    for x in range(1, n + 1):
        y = bytearray()
        for c in coeffs:
            acc = 0
            for d in range(k - 1, -1, -1):
                acc = _mul(acc, x) ^ c[d]
            y.append(acc)
        out.append(encode_share(k, x, bytes(y)))
    return out


def totp(secret: bytes, step: int, digits: int = 6) -> str:
    h = hmac.new(secret, struct.pack(">Q", step), hashlib.sha1).digest()
    o = h[19] & 15
    return str((struct.unpack(">I", h[o : o + 4])[0] & 0x7FFFFFFF) % 10**digits).zfill(digits)


# ---- standby node: restore and reach people without Cloudflare (H4 gate) -------------------


def load_escrow(envelope: Doc, key_b64: str, root: Doc) -> Doc:
    bundle: Doc = json.loads(decrypt_escrow(envelope, key_b64))
    if not verify_export(bundle, root):
        raise ValueError("bundle_signature")
    return bundle


def standby_init(bundle: Doc, db_path: str) -> dict[str, int]:
    db = sqlite3.connect(db_path)
    db.executescript(
        "CREATE TABLE IF NOT EXISTS heads(person TEXT, channel TEXT, address TEXT,"
        " UNIQUE(channel, address));"
        "CREATE TABLE IF NOT EXISTS follows(person TEXT, topic TEXT, seq INTEGER, status TEXT,"
        " PRIMARY KEY(person, topic));"
        "CREATE TABLE IF NOT EXISTS suppressions(hash TEXT, scope TEXT, PRIMARY KEY(hash, scope));"
    )
    heads = 0
    for p in bundle["signed"]["people"]:
        rows = [("email", e) for e in p["emails"]] + [
            (h["channel"], h["address"])
            for h in p.get("heads", [])
            if h["channel"] in ("ntfy", "matrix", "sms", "webpush")
        ]
        for ch, addr in rows:
            heads += db.execute(
                "INSERT OR IGNORE INTO heads VALUES (?,?,?)", (p["ref"], ch, addr)
            ).rowcount
        for o in p["ops"]:
            if not o.get("topic") or o["op"] == "REVOKE_ENDPOINT":
                continue
            status = {"FOLLOW": "following", "UNMUTE": "following", "MUTE": "muted"}.get(
                o["op"], "unfollowed"
            )
            db.execute(
                "INSERT INTO follows VALUES (?,?,?,?) ON CONFLICT(person, topic) DO UPDATE"
                " SET seq=excluded.seq, status=excluded.status WHERE excluded.seq > follows.seq",
                (p["ref"], o["topic"], o["seq"], status),
            )
    for s in bundle["signed"]["suppressions"]:
        db.execute("INSERT OR IGNORE INTO suppressions VALUES (?,?)", (s["hash"], s["scope"]))
    db.commit()
    people = db.execute("SELECT COUNT(DISTINCT person) FROM heads").fetchone()[0]
    db.close()
    return {"people": people, "heads": heads}


def suppress_hash(channel: str, address: str) -> str:
    a = address.strip().lower() if channel == "email" else address
    return hashlib.sha256(f"{channel}:{a}".encode()).hexdigest()


def standby_targets(db_path: str) -> list[tuple[str, str]]:
    """(channel, address) for everyone following critical notices, minus suppressed addresses."""
    db = sqlite3.connect(db_path)
    rows = db.execute(
        "SELECT h.channel, h.address FROM heads h JOIN follows f ON f.person=h.person"
        " AND f.topic='critical' AND f.status='following'"
    ).fetchall()
    sup = {(h, s) for h, s in db.execute("SELECT hash, scope FROM suppressions")}
    db.close()
    return [
        (c, a)
        for c, a in rows
        if (suppress_hash(c, a), "critical") not in sup and (suppress_hash(c, a), "*") not in sup
    ]


def standby_notify(db_path: str, title: str, text: str, send: bool = False) -> dict[str, int]:
    counts: dict[str, int] = {}
    smtp: smtplib.SMTP | None = None
    for channel, address in standby_targets(db_path):
        if channel not in ("email", "ntfy"):
            counts[f"{channel}_unsupported"] = counts.get(f"{channel}_unsupported", 0) + 1
            continue
        counts[channel] = counts.get(channel, 0) + 1
        if not send:
            continue
        if channel == "ntfy":
            u = urlsplit(address)
            if u.scheme != "https":
                continue
            body = json.dumps(
                {"topic": u.path.lstrip("/"), "title": title, "message": text, "priority": 4}
            ).encode()
            urllib.request.urlopen(
                urllib.request.Request(
                    f"https://{u.netloc}", data=body, headers={"content-type": "application/json"}
                ),
                timeout=10,
            )
        else:
            if smtp is None:
                smtp = smtplib.SMTP(
                    os.environ["SMTP_HOST"], int(os.environ.get("SMTP_PORT", "587")), timeout=20
                )
                smtp.starttls()
                if os.environ.get("SMTP_USER"):
                    smtp.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
            msg = EmailMessage()
            msg["From"], msg["To"], msg["Subject"] = os.environ["SMTP_FROM"], address, title
            msg.set_content(text)
            smtp.send_message(msg)
    if smtp is not None:
        smtp.quit()
    return counts


def _load(path: str) -> Doc:
    data: Doc = json.loads(Path(path).read_text("utf-8"))
    return data


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "shamir-combine":
        print(base64.b64encode(shamir_combine(argv[1:])).decode())
        return 0
    if len(argv) == 4 and argv[0] == "shamir-split":
        for s in shamir_split(base64.b64decode(argv[1]), int(argv[2]), int(argv[3])):
            print(s)
        return 0
    if len(argv) == 4 and argv[0] == "escrow-decrypt":
        print(
            json.dumps(
                load_escrow(_load(argv[1]), Path(argv[2]).read_text().strip(), _load(argv[3]))
            )
        )
        return 0
    if len(argv) == 5 and argv[0] == "standby-init":
        print(
            standby_init(
                load_escrow(_load(argv[1]), Path(argv[2]).read_text().strip(), _load(argv[3])),
                argv[4],
            )
        )
        return 0
    if len(argv) >= 4 and argv[0] == "standby-notify":
        print(standby_notify(argv[1], argv[2], argv[3], send="--send" in argv[4:]))
        return 0
    if len(argv) == 3 and argv[0] == "anchor-check":
        community = _load(argv[2])
        print(check_anchor(Path(argv[1]).read_text(), community["root"], community["destinations"]))
        return 0
    if len(argv) == 2 and argv[0] == "index":
        graph: list[Doc] = json.loads(Path(argv[1]).read_text("utf-8"))
        print(json.dumps(hydra_index(graph)))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
