#!/usr/bin/env bash
# Example TELEPATHY_BACKUP_COMMAND: encrypt with age, copy off-host with rclone (P11-06).
# Requires: age public key in AGE_RECIPIENT, an rclone remote named in RCLONE_REMOTE.
set -euo pipefail
src="$1"
age -r "$AGE_RECIPIENT" -o "$src.age" "$src"
rclone copy "$src.age" "$RCLONE_REMOTE" --immutable
rclone copy "${src%.db}.db.sha256" "$RCLONE_REMOTE" --immutable
rm -f "$src.age"
