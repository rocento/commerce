#!/usr/bin/env bash
# Compatibility entry point for the release frontend build recipe.
set -Eeuo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/server/repository-root.sh"
ROOT=$(find_repo_root)
exec bash "$ROOT/commerce-ops/workflows/release/build-frontend.sh" "$@"
