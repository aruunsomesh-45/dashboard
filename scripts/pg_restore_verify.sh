#!/usr/bin/env bash
# Restore a dump into a SCRATCH database and prove it matches the source row counts.
# Never restores over the source. Run this on a schedule (e.g. weekly) - an untested backup is a hope, not a backup.
#   ./pg_restore_verify.sh <dump-file> <source-url> <admin-url-to-scratch-server> [scratch_db_name]
# Example:
#   ./pg_restore_verify.sh backups/125east-2026....dump postgres://u:p@h:5433/commerce_perf postgres://u:p@h:5433/postgres
set -euo pipefail

DUMP_FILE="${1:?dump file}"; SRC_URL="${2:?source url}"; ADMIN_URL="${3:?admin url (db=postgres)}"
SCRATCH="${4:-restore_verify_$(date -u +%Y%m%d%H%M%S)}"
PG_BIN="${PG_BIN:-}"
bin() { echo "${PG_BIN:+$PG_BIN/}$1"; }

sha256sum -c "$DUMP_FILE.sha256"
"$(bin psql)" "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$SCRATCH\""
SCRATCH_URL="${ADMIN_URL%/*}/$SCRATCH"
trap '"$(bin psql)" "$ADMIN_URL" -c "DROP DATABASE IF EXISTS \"$SCRATCH\"" >/dev/null' EXIT

"$(bin pg_restore)" --no-owner --no-privileges --exit-on-error --dbname="$SCRATCH_URL" "$DUMP_FILE"

COUNTS_SQL="
select 'commerce_order', count(*) from commerce_order union all
select 'commerce_orderline', count(*) from commerce_orderline union all
select 'commerce_paymentattempt', count(*) from commerce_paymentattempt union all
select 'commerce_shipment', count(*) from commerce_shipment union all
select 'tenancy_workspace', count(*) from tenancy_workspace union all
select 'tenancy_brand', count(*) from tenancy_brand union all
select 'accounts_user', count(*) from accounts_user order by 1"
src="$("$(bin psql)" "$SRC_URL" -At -F, -c "$COUNTS_SQL")"
dst="$("$(bin psql)" "$SCRATCH_URL" -At -F, -c "$COUNTS_SQL")"
echo "--- source ---"; echo "$src"; echo "--- restored ---"; echo "$dst"
if [ "$src" = "$dst" ]; then echo "RESTORE VERIFIED: row counts match"; else echo "RESTORE MISMATCH" >&2; exit 1; fi
