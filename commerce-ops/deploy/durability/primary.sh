#!/bin/sh
set -eu
install -d -m 700 -o postgres -g postgres /archive
# Host bind mounts can be noexec (Docker Desktop). Source a container-local hook
# which explicitly invokes the shell for the read-only mounted implementation.
printf '%s\n' 'sh /opt/durability/configure-primary.sh' > /docker-entrypoint-initdb.d/20-replication.sh
chmod 644 /docker-entrypoint-initdb.d/20-replication.sh
exec /usr/local/bin/docker-entrypoint.sh postgres \
  -c fsync=on -c synchronous_commit=on -c full_page_writes=on -c wal_level=replica \
  -c archive_mode=on -c 'archive_command=sh /opt/durability/archive-wal.sh %p %f' \
  -c archive_timeout=60s -c wal_keep_size=256MB
