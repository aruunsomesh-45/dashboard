# Postgres backup & restore

Scripts: `scripts/pg_backup.sh` (dump) and `scripts/pg_restore_verify.sh` (restore into a scratch DB and compare row counts).

## Daily backup
1. Schedule `pg_backup.sh` once a day (cron / ECS scheduled task / GitHub Actions cron):
   ```
   BACKUP_DATABASE_URL=postgres://backup_user:***@db-host:5432/commerce_intel \
   BACKUP_DIR=/var/backups/125east BACKUP_RETENTION_DAYS=14 ./scripts/pg_backup.sh
   ```
   It writes `125east-<UTC stamp>.dump` (pg_dump custom format), checks the dump is listable, writes a `.sha256`,
   and deletes local dumps older than the retention window.
2. Copy `$BACKUP_DIR` off the database host (S3/GCS with versioning + lifecycle rule). A backup on the same disk
   as the database is not a backup.
3. Use a dedicated read-only DB role for `backup_user` (`pg_read_all_data`).
4. If you use a managed Postgres (Supabase/RDS) also enable its native PITR; these dumps are the portable second layer.

**Client/server version rule:** `pg_dump`/`pg_restore` must be the same major version as the server. Running PG18
client tools against a PG16 server produced `unrecognized configuration parameter "transaction_timeout"` during
restore (observed while testing these scripts). Run the scripts in a `postgres:<server-major>` container if in doubt.

## Restore procedure (disaster)
1. Provision an empty Postgres of the same major version. Do **not** restore over a live database.
2. `sha256sum -c 125east-<stamp>.dump.sha256`
3. `createdb commerce_intel_restored`
4. `pg_restore --no-owner --no-privileges --exit-on-error --dbname=postgres://.../commerce_intel_restored 125east-<stamp>.dump`
5. Point `DATABASE_URL` at the restored DB, run `python manage.py migrate --check` (must report no unapplied migrations),
   then `python scripts/smoke_staging.py`.
6. Switch traffic. Keep the damaged DB for forensics.

## Tested restore drill (run weekly)
`scripts/pg_restore_verify.sh <dump> <source-url> <admin-url>` restores into a throw-away database, compares row counts
for orders, order lines, payments, shipments, workspaces, brands and users against the source, prints
`RESTORE VERIFIED` or exits non-zero, and drops the scratch database.

Evidence from the run on this repo (10,000-order dataset, postgres:16 client + server): dump 2.3 MB, checksum OK,
restored counts identical to source for all 7 tables (commerce_order 10000, commerce_orderline 20000,
commerce_paymentattempt 10000, commerce_shipment 10000, tenancy_workspace 1, tenancy_brand 1, accounts_user 1).

## Not covered
- RPO is 24h with daily dumps; use PITR/WAL archiving if that is too long.
- Integration credentials are AES-GCM encrypted with a key derived from `INTEGRATION_ENCRYPTION_KEY` (or `SECRET_KEY`).
  **Back that key up separately** - a restored DB is useless for sync without it.
