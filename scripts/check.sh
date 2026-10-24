#!/usr/bin/env bash
# Everything CI runs, on your machine (no GitHub Actions minutes). Use before pushing:
#   scripts/check.sh            # both stacks
#   scripts/check.sh worker     # Cloudflare Worker only
# Optional pre-push hook:  ln -s ../../scripts/check.sh .git/hooks/pre-push
set -euo pipefail
cd "$(dirname "$0")/.."
what="${1:-all}"
if [[ "$what" == all || "$what" == worker ]]; then
  (cd worker && npm ci --silent && npm run typecheck && npm test && npx wrangler deploy --dry-run --outdir dist >/dev/null)
fi
if [[ "$what" == all || "$what" == python ]]; then
  uv sync --locked -q && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest -q
fi
echo "all checks passed"
