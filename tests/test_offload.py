from __future__ import annotations

import io
import json

import docx

from telepathy.ops.offload import run


def _docx(text: str) -> bytes:
    d = docx.Document()
    d.add_paragraph(text)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


class FakeHttp:
    def __init__(self, files: dict[str, bytes]) -> None:
        self.files = files
        self.posted: list[dict] = []

    def __call__(self, method, url, headers, body):
        if url.endswith("/admin/docs/pending?limit=10"):
            assert headers["authorization"] == "Bearer admintoken"
            return json.dumps(
                {
                    "documents": [
                        {"source_id": "s", "msg_id": 1, "file_id": "A", "file_name": "plan.docx"},
                        {"source_id": "s", "msg_id": 2, "file_id": "B", "file_name": "broken.docx"},
                        {"source_id": "s", "msg_id": 3, "file_id": "C", "file_name": "x.exe"},
                    ]
                }
            ).encode()
        if url.endswith("/getFile"):
            fid = json.loads(body)["file_id"]
            return json.dumps({"ok": True, "result": {"file_path": fid}}).encode()
        if "/file/bot" in url:
            return self.files[url.rsplit("/", 1)[1]]
        if url.endswith("/admin/docs/result"):
            self.posted.append(json.loads(body))
            return json.dumps(
                {"ok": True, "stored": len(json.loads(body).get("chunks", []))}
            ).encode()
        raise AssertionError(url)


def test_offload_parses_and_reports_without_logging_content(capsys):
    http = FakeHttp({"A": _docx("The hackathon budget is approved"), "B": b"not a zip", "C": b"MZ"})
    counts = run("https://w.example", "admintoken", "123:SECRET", http=http)
    assert counts == {"done": 1, "skipped": 1, "failed": 1, "chunks": 1}
    by_id = {p["msg_id"]: p for p in http.posted}
    assert by_id[1]["status"] == "done" and "hackathon" in by_id[1]["chunks"][0]["text"]
    assert by_id[2]["status"] == "failed" and "zip" not in json.dumps(by_id[2])
    assert by_id[3] == {"source_id": "s", "msg_id": 3, "status": "skipped", "error": "unsupported"}
    out = capsys.readouterr()
    assert "SECRET" not in out.out + out.err and "hackathon" not in out.out + out.err


def test_network_errors_are_reported_as_failed():
    class Boom(FakeHttp):
        def __call__(self, method, url, headers, body):
            if "/file/bot" in url:
                raise TimeoutError("timed out")
            return super().__call__(method, url, headers, body)

    http = Boom({})
    counts = run("https://w.example", "admintoken", "t", http=http)
    assert counts["failed"] == 2  # A and B fail to download; C is skipped without downloading
    assert all(p["error"] in ("TimeoutError", "unsupported") for p in http.posted)
