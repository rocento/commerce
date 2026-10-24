#!/usr/bin/env bash
# Compatibility command for the canonical demo-seeding host implementation.
set -Eeuo pipefail
. "$(dirname -- "${BASH_SOURCE[0]}")/repository-root.sh"
ROOT=$(find_repo_root)
exec bash "$ROOT/commerce-ops/cloud/host/seed-demo.sh" "$@"
