#!/bin/sh
set -eu
source_file=$1
wal_file=$2
case "$wal_file" in *[!0-9A-Fa-f.historybackup]*|'') exit 1;; esac
# Never overwrite a different archived segment. Retries after a lost success are safe.
if [ -f "/archive/$wal_file" ]; then
    cmp -s "$source_file" "/archive/$wal_file"
    exit $?
fi
archive_temp="/archive/.$wal_file.$$"
trap 'rm -f "$archive_temp"' EXIT
cp "$source_file" "$archive_temp"
sync "$archive_temp"
# Only the primary archives into this namespace. Publish the complete file atomically.
mv "$archive_temp" "/archive/$wal_file"
sync /archive
