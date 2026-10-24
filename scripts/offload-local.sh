#!/usr/bin/env bash
# Parse queued PDF/DOCX/PPTX on any machine you control instead of GitHub's runners.
# Files then never pass through GitHub. Needs uv and three env vars (keep them out of git):
#   WORKER_URL=https://telepathy.<you>.workers.dev ADMIN_TOKEN=... BOT_TOKEN=... scripts/offload-local.sh
# Every 30 minutes from cron:  */30 * * * * cd /path/to/Telepathy && ./scripts/offload-local.sh >> offload.log 2>&1
# Prints counts only.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${WORKER_URL:?}" "${ADMIN_TOKEN:?}" "${BOT_TOKEN:?}"
uv sync --locked --no-dev -q
OFFLOAD_BATCH="${OFFLOAD_BATCH:-25}" uv run --no-dev python -m telepathy.ops.offload
