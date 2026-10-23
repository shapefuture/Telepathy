# Operator runbook

Single Linux host, one process (`telepathy run`): Telegram long polling plus a background
worker for sends, introductions, the digest, retention and backups. State lives in one SQLite
file (WAL mode).

## 1. First deployment

1. **Create the bot** with @BotFather:
   - `/setprivacy` → **Disable** (otherwise the bot only sees commands in groups).
   - `/setjoingroups` → Enable while you add it, then Disable to stop strangers adding it.
2. **Configure**: copy `.env.example` to `/etc/telepathy/telepathy.env` (mode 600). Set
   `TELEPATHY_BOT_TOKEN` and `TELEPATHY_OWNER_IDS` (your numeric Telegram ID; @userinfobot
   shows it).
3. **Install** (systemd):
   ```bash
   sudo useradd --system --home /var/lib/telepathy telepathy
   sudo install -d -o telepathy -m 700 /var/lib/telepathy
   sudo git clone https://github.com/shapefuture/Telepathy /opt/telepathy
   cd /opt/telepathy && sudo uv sync --locked --no-dev
   sudo cp deploy/telepathy.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now telepathy
   journalctl -u telepathy -f
   ```
   Or Docker: `docker compose -f deploy/docker-compose.yml up -d --build`.
4. **Enable groups**: add the bot to each group **as admin** (needed for join/leave events),
   then send `/enable` in the group. Visibility options:
   | Visibility | Who can search it |
   |---|---|
   | `MEMBER_CONSENTED` (default) | members seen in that group |
   | `PUBLIC_APPROVED` | every community member |
   | `INTERNAL_RESTRICTED` | moderators/admins/owners seen in that group |
   The bot posts a collection notice. Pin it.
5. **Optional history import**: in Telegram Desktop, choose Export chat history → JSON, copy
   it to the host, then run `telepathy import result.json`. It only works for enabled groups.
   Re-running is safe. Messages older than the retention period are purged that night.
6. **Off-host backups**: set `TELEPATHY_BACKUP_COMMAND` to a script like
   `deploy/offsite-backup.example.sh` (encrypts with `age`, uploads with `rclone`).

## 2. Daily operation

| When | What happens |
|---|---|
| 03:30 local | retention purge |
| 04:00 local | verified online backup (`data/backups`, 14 kept) |
| 09:00 local | admin-only digest DM to owners/admins |
| every 5 s | sends, expiries (72 h invites, 14 d requests), 24 h reminders, document parsing |

Owner commands (DM the bot): `/status`, `/sources`, `/uncertain`, `/digest_now`.
Group commands (owner + chat admin): `/enable`, `/disable`, `/retention <days>`,
`/forget` (reply to a message).

## 3. Incidents

| Symptom | Action |
|---|---|
| `/status` shows **sends uncertain** > 0 | The process died or the network failed mid-send. Run `/uncertain` and press Delivered / Not delivered. The bot **never** resends these automatically. |
| **jobs failed** > 0 | `sqlite3 telepathy.db "select kind,last_error from jobs where state='failed'"`. Fix the cause. Daily jobs re-run the next day. |
| "last message seen" grows while groups are active | Check `journalctl -u telepathy`. Confirm privacy mode is off and the bot is still in the group. |
| Member asks to delete their data | They can use `/forget_me` themselves. An owner can also reply `/forget` to a single message. |
| A group must stop being collected | `/disable` in the group. Its messages drop out of all answers immediately. |
| Bot token leaked | `/revoke` in BotFather, update the env file, `systemctl restart telepathy`. |
| Disk full | Writes fail but nothing is lost. Free space (old backups first), then restart. |

## 4. Restore

```bash
sudo systemctl stop telepathy
telepathy verify /var/lib/telepathy/backups/telepathy-YYYYMMDDTHHMMSSZ.db   # must print ok
sha256sum -c /var/lib/telepathy/backups/telepathy-YYYYMMDDTHHMMSSZ.db.sha256
cp /var/lib/telepathy/telepathy.db /var/lib/telepathy/telepathy.db.broken
cp <backup>.db /var/lib/telepathy/telepathy.db && rm -f /var/lib/telepathy/telepathy.db-wal /var/lib/telepathy/telepathy.db-shm
sudo systemctl start telepathy
```
**Monthly**: restore the latest backup onto a scratch machine and run `telepathy status`
against it (`TELEPATHY_DB_PATH=<copy> telepathy status`).

## 5. Upgrades and rollback

- Migrations are forward-only and additive. `telepathy migrate` runs before each start.
- Take a backup first: `telepathy backup`.
- Roll back code by checking out the previous release tag. **Never** restore an older schema
  over newer data. If a migration must be undone, restore the pre-upgrade backup.

## 6. What leaves the host

Only Telegram Bot API calls. External AI providers (NVIDIA NIM, Decision/d3) are **not
called** in v1, and the egress guard denies them by default.
