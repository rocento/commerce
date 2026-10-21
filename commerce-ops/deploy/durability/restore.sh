#!/bin/sh
set -eu
: "${BACKUP_ID:?Specify a verified backup directory name}"
: "${RECOVERY_TARGET_NAME:?Specify a named PostgreSQL restore point}"
case "$BACKUP_ID" in *[!a-zA-Z0-9_-]*|'') exit 1;; esac
case "$RECOVERY_TARGET_NAME" in *[!a-zA-Z0-9_-]*|'') exit 1;; esac
install -d -m 700 -o postgres -g postgres "$PGDATA"
if [ -n "$(ls -A "$PGDATA")" ]; then
    echo 'Restore requires an empty destination volume; refusing overwrite' >&2
    exit 1
fi
pg_verifybackup "/backups/$BACKUP_ID"
cp -a "/backups/$BACKUP_ID/." "$PGDATA/"
printf '\nrestore_command = '\''cp /archive/%%f %%p'\''\nrecovery_target_name = '\''%s'\''\nrecovery_target_action = '\''promote'\''\n' "$RECOVERY_TARGET_NAME" >> "$PGDATA/postgresql.auto.conf"
touch "$PGDATA/recovery.signal"
chown -R postgres:postgres "$PGDATA"
exec gosu postgres postgres -D "$PGDATA" -c archive_mode=off -c synchronous_standby_names= \
    -c fsync=on -c synchronous_commit=on -c full_page_writes=on
