#!/bin/sh
set -eu
: "${REPLICATION_PASSWORD:?Set a dedicated replication password}"
export PGPASSWORD="$REPLICATION_PASSWORD"
export PGUSER=commerce_replicator PGHOST=postgres PGPORT=5432
install -d -m 700 -o postgres -g postgres "$PGDATA"
if [ ! -f "$PGDATA/PG_VERSION" ]; then
    if [ -n "$(ls -A "$PGDATA")" ]; then
        echo 'Refusing to overwrite a nonempty standby directory' >&2
        exit 1
    fi
    gosu postgres pg_basebackup -D "$PGDATA" -X stream --checkpoint=fast -R \
      -d 'application_name=m14_standby'
fi
exec gosu postgres postgres -D "$PGDATA" -c fsync=on -c synchronous_commit=on \
  -c full_page_writes=on -c archive_mode=off -c synchronous_standby_names= \
  -c 'primary_conninfo=host=postgres port=5432 user=commerce_replicator application_name=m14_standby'
