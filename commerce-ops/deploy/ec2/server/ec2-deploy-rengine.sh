#!/usr/bin/env bash
# Compatibility command for the canonical rengine host deployment.
set -Eeuo pipefail
. "$(dirname -- "${BASH_SOURCE[0]}")/repository-root.sh"
ROOT=$(find_repo_root)
exec bash "$ROOT/commerce-ops/cloud/host/deploy-rengine.sh" "$@"
