# syntax=docker/dockerfile:1.7
# Pin the base image by digest for releases (P01-10): docker pull python:3.12-slim and
# replace the tag below with python:3.12-slim@sha256:<digest>.
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN uv sync --locked --no-dev

RUN useradd --system --uid 10001 --home /data telepathy && mkdir -p /data && chown telepathy /data
USER telepathy
ENV TELEPATHY_DB_PATH=/data/telepathy.db TELEPATHY_BACKUP_DIR=/data/backups
VOLUME ["/data"]

HEALTHCHECK --interval=60s --timeout=10s CMD ["/app/.venv/bin/python", "-c", \
  "import sqlite3,os; sqlite3.connect(os.environ['TELEPATHY_DB_PATH']).execute('select 1')"]

ENTRYPOINT ["/app/.venv/bin/telepathy"]
CMD ["run"]
