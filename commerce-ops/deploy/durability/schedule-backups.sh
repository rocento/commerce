#!/bin/sh
set -eu
interval=${BACKUP_INTERVAL_SECONDS:-21600}
case "$interval" in *[!0-9]*|'') exit 1;; esac
[ "$interval" -ge 60 ] || exit 1
trap 'exit 0' TERM INT
while :; do
    sh /opt/durability/backup.sh
    sleep "$interval" &
    wait "$!"
done
