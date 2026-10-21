#!/usr/bin/env bash
# Compatibility entry point; maintained implementation: commerce-ops/scripts/local/local-compose.sh
exec bash "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/local/local-compose.sh" "$@"
