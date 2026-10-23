"""Architecture fences (P01-08): domain/storage/retrieval stay vendor-free."""

from __future__ import annotations

import ast
import pathlib

SRC = pathlib.Path(__file__).resolve().parents[1] / "src" / "telepathy"
VENDOR = {"aiogram", "httpx", "requests", "aiohttp", "openai", "fastapi"}
PURE = ["domain", "storage", "retrieval", "ingest", "ports.py"]


def _imports(path: pathlib.Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            out.add(node.module.split(".")[0])
    return out


def test_core_has_no_vendor_imports():
    for part in PURE:
        target = SRC / part
        files = [target] if target.is_file() else list(target.rglob("*.py"))
        for f in files:
            bad = _imports(f) & VENDOR
            assert not bad, f"{f.relative_to(SRC)} imports {bad}"


def test_settings_repr_hides_token():
    from telepathy.config import Settings

    s = Settings.from_env({"TELEPATHY_BOT_TOKEN": "123:SECRET", "TELEPATHY_OWNER_IDS": "1, 2"})
    assert "SECRET" not in repr(s)
    assert s.owner_telegram_ids == {1, 2}


def test_migrations_are_idempotent(tmp_path):
    from telepathy.storage import db

    c = db.connect(tmp_path / "t.db")
    assert db.migrate(c) == ["0001_init"]
    assert db.migrate(c) == []
    assert c.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert c.execute("PRAGMA foreign_keys").fetchone()[0] == 1
