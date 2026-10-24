#!/usr/bin/env bash
# Compatibility command for the canonical cloud host deployment runner.
set -Eeuo pipefail
. "$(dirname -- "${BASH_SOURCE[0]}")/repository-root.sh"
ROOT=$(find_repo_root)
exec bash "$ROOT/commerce-ops/cloud/host/deploy.sh" "$@"
