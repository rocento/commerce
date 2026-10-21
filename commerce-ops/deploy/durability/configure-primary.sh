#!/bin/sh
set -eu
: "${REPLICATION_PASSWORD:?Set a dedicated replication password}"
# psql reads the password from its environment, not command-line arguments.
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
\getenv replication_password REPLICATION_PASSWORD
SELECT 'CREATE ROLE commerce_replicator WITH LOGIN REPLICATION'
WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_replicator') \gexec
SELECT format('ALTER ROLE commerce_replicator WITH LOGIN REPLICATION PASSWORD %L', :'replication_password') \gexec
SQL
hba_rule='host replication commerce_replicator samenet scram-sha-256'
if ! grep -qxF "$hba_rule" "$PGDATA/pg_hba.conf"; then
    printf '\n%s\n' "$hba_rule" >> "$PGDATA/pg_hba.conf"
fi
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT pg_reload_conf()'
