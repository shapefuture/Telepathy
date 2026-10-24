#!/usr/bin/env bash
# Encrypted off-Cloudflare D1 backup from your machine (replaces the d1-backup workflow).
#   AGE_RECIPIENT=age1... scripts/backup-local.sh [output-dir]
# Needs: wrangler login (or CLOUDFLARE_API_TOKEN), age. Plaintext is shredded right away.
set -euo pipefail
cd "$(dirname "$0")/../worker"
: "${AGE_RECIPIENT:?set AGE_RECIPIENT to your age public key}"
out="${1:-$HOME/telepathy-backups}"
mkdir -p "$out"; umask 077
name="telepathy-$(date -u +%Y%m%dT%H%M%SZ)"
tmp="$(mktemp -d)"
npx wrangler d1 export telepathy --remote --output "$tmp/$name.sql" >/dev/null
age -r "$AGE_RECIPIENT" -o "$out/$name.sql.age" "$tmp/$name.sql"
shred -u "$tmp/$name.sql" 2>/dev/null || rm -f "$tmp/$name.sql"
rmdir "$tmp"
echo "wrote $out/$name.sql.age"
