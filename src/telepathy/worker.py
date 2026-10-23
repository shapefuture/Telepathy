"""Background worker: one asyncio task next to polling, same process, same connection.

Every step is idempotent and isolated, so a crash or restart in any step is safe:
  * outbox dispatch (at-most-once from normal retries; unknown outcomes -> uncertain)
  * introduction expiry and reminders
  * daily digest / retention / backup, scheduled through the job ledger by local date
  * document ingestion jobs
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from collections.abc import Awaitable, Callable
from datetime import datetime, time
from typing import Any

from telepathy.config import Settings
from telepathy.domain.types import utcnow
from telepathy.ingest.documents import store_document
from telepathy.ops.backup import backup
from telepathy.services import data_rights, digest, intros
from telepathy.services.messages import payload
from telepathy.storage import jobs, outbox
from telepathy.storage.db import transaction

log = logging.getLogger(__name__)

SendFn = Callable[[str, dict[str, Any]], Awaitable[str]]
FetchFn = Callable[[str], Awaitable[bytes]]

RETENTION_AT = time(3, 30)
BACKUP_AT = time(4, 0)
WORKER_ID = "worker-1"


class Worker:
    def __init__(
        self,
        conn: sqlite3.Connection,
        settings: Settings,
        send: SendFn,
        fetch_file: FetchFn,
        *,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self.conn = conn
        self.settings = settings
        self.send = send
        self.fetch_file = fetch_file
        self.clock = clock

    async def run_forever(self, interval: float = 5.0) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("worker tick failed")
            await asyncio.sleep(interval)

    async def tick(self) -> None:
        now = self.clock()
        for name, step in (
            ("expire", self._expire),
            ("reminders", self._reminders),
            ("schedule", self._schedule),
        ):
            try:
                step(now)
            except Exception:
                log.exception("worker step %s failed", name)
        await self._run_jobs()
        await self.dispatch_pending()

    # -- steps -------------------------------------------------------------------------

    def _expire(self, now: datetime) -> None:
        n = intros.expire_due(self.conn, now)
        if n:
            log.info("expired %d introduction(s)", n)

    def _reminders(self, now: datetime) -> None:
        intros.send_reminders(self.conn, now)

    def _local_due(self, now: datetime, at: time) -> str | None:
        day = digest.due_local_day(now, at, self.settings.timezone)
        return day.isoformat() if day else None

    def _schedule(self, now: datetime) -> None:
        cid = self.settings.community_id
        for kind, at in (
            ("digest", self.settings.digest_time),
            ("retention", RETENTION_AT),
            ("backup", BACKUP_AT),
        ):
            day = self._local_due(now, at)
            if day:
                jobs.enqueue(self.conn, kind, f"{kind}:{cid}:{day}", {"day": day}, now=now)

    async def dispatch_pending(self, limit: int = 20) -> int:
        n = 0
        for eid in outbox.pending_ids(self.conn, limit):
            state = await outbox.dispatch(self.conn, eid, self.send, now=self.clock)
            if state == "pending":  # rate limited: stop this round
                break
            n += 1
        return n

    async def _run_jobs(self, max_jobs: int = 10) -> None:
        for _ in range(max_jobs):
            now = self.clock()
            job = jobs.lease(self.conn, WORKER_ID, now=now)
            if job is None:
                return
            try:
                await self._run(job)
            except Exception as exc:
                log.exception("job %s (%s) failed", job.kind, job.id)
                jobs.fail(self.conn, job, f"{type(exc).__name__}: {exc}", now=self.clock())
            else:
                jobs.complete(self.conn, job, now=self.clock())

    async def _run(self, job: jobs.Job) -> None:
        if job.kind == "digest":
            await self._digest(job)
        elif job.kind == "retention":
            n = data_rights.apply_retention(self.conn, self.clock())
            log.info("retention purged %d message(s)", n)
        elif job.kind == "backup":
            s = self.settings
            # Synchronous on purpose: the connection must not be shared across threads.
            res = backup(
                self.conn, s.backup_dir, self.clock(), keep=s.backup_keep, command=s.backup_command
            )
            if res.integrity != "ok":
                raise RuntimeError(f"backup integrity check failed: {res.integrity}")
            log.info("backup written: %s", res.path.name)
        elif job.kind == "doc.ingest":
            await self._document(job)
        else:
            raise ValueError(f"unknown job kind {job.kind}")

    async def _digest(self, job: jobs.Job) -> None:
        s = self.settings
        end = self.clock()
        start = digest.window_start(self.conn, end)
        keys: list[str] = []
        with transaction(self.conn):
            for r in digest.recipients(self.conn, s.community_id):
                text = digest.build(self.conn, s.community_id, r.member_id, start, end, s.timezone)
                if text is None:
                    continue
                key = f"{job.dedup_key}:{r.member_id}"
                outbox.create_intent(
                    self.conn,
                    "telegram.dm",
                    f"tg:{r.telegram_user_id}",
                    payload(r.telegram_user_id, text),
                    key,
                    now=end,
                )
                keys.append(key)
        await self.dispatch_pending(limit=max(20, len(keys)))
        states = outbox.states_for_keys(self.conn, keys)
        if any(st in ("pending", "dispatching") for st in states.values()):
            raise RuntimeError("digest deliveries still pending; will retry")
        with transaction(self.conn):
            digest.advance_checkpoint(self.conn, end)  # only after delivery (P10-08)
            digest.record(self.conn, end.date(), sum(st == "sent" for st in states.values()))

    async def _document(self, job: jobs.Job) -> None:
        p = job.payload
        data = await self.fetch_file(p["file_id"])
        doc_id, status, n = store_document(
            self.conn,
            source_id=p["source_id"],
            message_row_id=p["message_row_id"],
            citation_uri=p.get("citation_uri"),
            event_at=p["event_at"],
            file_name=p["file_name"],
            data=data,
        )
        log.info("document %s: %s, %d excerpt(s)", doc_id or "-", status, n)
