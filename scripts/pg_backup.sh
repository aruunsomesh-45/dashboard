#!/usr/bin/env bash
# Daily Postgres backup (custom format, compressed). Run from cron / a scheduler.
#   BACKUP_DATABASE_URL=postgres://user:pass@host:5432/dbname BACKUP_DIR=/var/backups/125east ./pg_backup.sh
# Keeps BACKUP_RETENTION_DAYS (default 14) of local dumps. Ship $BACKUP_DIR off-host (S3/GCS) in your scheduler.
set -euo pipefail

: "${BACKUP_DATABASE_URL:?set BACKUP_DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
PG_BIN="${PG_BIN:-}"   # optional dir containing pg_dump, e.g. "/c/Program Files/PostgreSQL/18/bin"
DUMP="${PG_BIN:+$PG_BIN/}pg_dump"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/125east-$stamp.dump"

"$DUMP" --format=custom --compress=6 --no-owner --no-privileges --file="$out" "$BACKUP_DATABASE_URL"
# A dump that cannot be listed is not a backup.
"${PG_BIN:+$PG_BIN/}pg_restore" --list "$out" > /dev/null
sha256sum "$out" > "$out.sha256"
find "$BACKUP_DIR" -name '125east-*.dump*' -mtime +"$RETENTION" -delete
echo "backup ok: $out ($(du -h "$out" | cut -f1))"
