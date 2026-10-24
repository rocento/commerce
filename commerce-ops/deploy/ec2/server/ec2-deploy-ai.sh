#!/usr/bin/env bash
# Compatibility entry point; implementation lives in commerce-ops/cloud/host.
set -Eeuo pipefail
. "$(dirname -- "${BASH_SOURCE[0]}")/repository-root.sh"
ROOT=$(find_repo_root)
exec bash "$ROOT/commerce-ops/cloud/host/deploy-ai.sh" "$@"
