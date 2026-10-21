#!/bin/sh
set -eu
export PGHOST=postgres PGPASSWORD="$POSTGRES_PASSWORD" PGUSER="$POSTGRES_USER" PGDATABASE="$POSTGRES_DB"
ready=$(psql -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM pg_stat_replication WHERE application_name='m14_standby' AND state='streaming'")
[ "$ready" = 1 ] || { echo 'Exactly one streaming standby is required' >&2; exit 1; }
psql -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET synchronous_standby_names = 'FIRST 1 (m14_standby)'"
psql -v ON_ERROR_STOP=1 -c 'SELECT pg_reload_conf()'
attempt=0
until [ "$(psql -v ON_ERROR_STOP=1 -Atc "SELECT count(*) FROM pg_stat_replication WHERE application_name='m14_standby' AND sync_state='sync'")" = 1 ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 30 ] || exit 1
    sleep 1
done
printf '%s\n' 'Synchronous standby is active; acknowledged commits require its durable WAL flush.'
