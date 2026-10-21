#!/bin/sh
set -eu
last=$(cat /backups/last-success)
case "$last" in *[!0-9]*|'') exit 1;; esac
age=$(( $(date +%s) - last ))
[ "$age" -ge 0 ] && [ "$age" -le $(( ${BACKUP_INTERVAL_SECONDS:-21600} * 2 )) ]
