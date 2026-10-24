"""Parse heavy documents for the Cloudflare Worker (run by GitHub Actions).

The Worker can't parse PDF/DOCX/PPTX inside its CPU limit, so it queues them. This job fetches
the queue, downloads each file from Telegram, parses it with the v1 parsers and posts the text
chunks back. It runs only when the owner enabled OFFLOAD_DOCUMENTS, because files pass through
GitHub's runners.

Privacy rules (the repo is public, so workflow logs are public):
  * never print file names, contents, URLs (the file URL contains the bot token) or errors
    from parsers verbatim; only counts and statuses are logged
  * nothing is written to disk except the interpreter's own temp handling

Usage: WORKER_URL=... ADMIN_TOKEN=... BOT_TOKEN=... python -m telepathy.ops.offload
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from collections.abc import Callable
from typing import Any

from telepathy.ingest import documents

MAX_BYTES = 20 * 1024 * 1024
Http = Callable[[str, str, dict[str, str], bytes | None], bytes]


def _http(method: str, url: str, headers: dict[str, str], body: bytes | None) -> bytes:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)  # noqa: S310
    with urllib.request.urlopen(req, timeout=60) as res:  # noqa: S310 (https URLs only)
        data: bytes = res.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("response too large")
    return data


def download(bot_token: str, file_id: str, http: Http) -> bytes:
    meta = json.loads(
        http(
            "POST",
            f"https://api.telegram.org/bot{bot_token}/getFile",
            {"content-type": "application/json"},
            json.dumps({"file_id": file_id}).encode(),
        )
    )
    if not meta.get("ok") or not meta["result"].get("file_path"):
        raise ValueError("file unavailable")
    return http(
        "GET",
        f"https://api.telegram.org/file/bot{bot_token}/{meta['result']['file_path']}",
        {},
        None,
    )


def run(
    worker_url: str, admin_token: str, bot_token: str, *, http: Http = _http, limit: int = 10
) -> dict[str, int]:
    base = worker_url.rstrip("/")
    auth = {"authorization": f"Bearer {admin_token}", "content-type": "application/json"}
    pending = json.loads(http("GET", f"{base}/admin/docs/pending?limit={limit}", auth, None))
    counts = {"done": 0, "skipped": 0, "failed": 0, "chunks": 0}
    for d in pending.get("documents", []):
        result: dict[str, Any] = {"source_id": d["source_id"], "msg_id": d["msg_id"]}
        try:
            if documents.extension(d["file_name"]) not in documents.SUPPORTED:
                parsed = documents.ParsedDocument("unsupported", "")  # don't even download it
            else:
                parsed = documents.parse(d["file_name"], download(bot_token, d["file_id"], http))
            if parsed.status == "parsed":
                chunks = documents.chunk(parsed.segments)
                result |= {
                    "status": "done",
                    "chunks": [{"locator": c.locator, "text": c.text} for c in chunks],
                }
            elif parsed.status in ("needs_ocr", "unsupported"):
                result |= {"status": "skipped", "error": parsed.status}
            else:
                result |= {"status": "failed", "error": "parse failed"}
        except Exception as exc:  # one bad file must not stop the batch
            result |= {"status": "failed", "error": type(exc).__name__}
        reply = json.loads(
            http("POST", f"{base}/admin/docs/result", auth, json.dumps(result).encode())
        )
        counts[result["status"]] += 1
        counts["chunks"] += int(reply.get("stored", 0))
    return counts


def main() -> int:
    missing = [k for k in ("WORKER_URL", "ADMIN_TOKEN", "BOT_TOKEN") if not os.environ.get(k)]
    if missing:
        print(f"missing environment: {', '.join(missing)}", file=sys.stderr)
        return 2
    batch = int(os.environ.get("OFFLOAD_BATCH", "25"))
    counts = run(
        os.environ["WORKER_URL"], os.environ["ADMIN_TOKEN"], os.environ["BOT_TOKEN"], limit=batch
    )
    print(json.dumps(counts))  # counts only: safe for public logs
    return 0


if __name__ == "__main__":
    sys.exit(main())
