#!/bin/sh
set -eu
: "${REPLICATION_PASSWORD:?Set a dedicated replication password}"
export PGPASSWORD="$REPLICATION_PASSWORD" PGUSER=commerce_replicator PGHOST=postgres PGPORT=5432
# Run the scheduler as root only to provision the volume; backups run as postgres.
if [ "$(id -u)" = 0 ]; then
    install -d -m 700 -o postgres -g postgres /backups
    exec gosu postgres sh "$0" "$@"
fi
backup_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
backup_path="/backups/.inprogress-$backup_id"
pg_basebackup -D "$backup_path" -X stream --checkpoint=fast
pg_verifybackup "$backup_path"
mv "$backup_path" "/backups/$backup_id"
date +%s > /backups/.last-success.tmp
sync /backups/.last-success.tmp
mv /backups/.last-success.tmp /backups/last-success
sync /backups
printf 'Verified base backup: %s\n' "$backup_id"
