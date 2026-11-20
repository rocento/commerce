# Source compatibility for commands that still load the historical helper path.
. "$(dirname -- "${BASH_SOURCE[0]}")/repository-root.sh"
ROOT=$(find_repo_root)
. "$ROOT/commerce-ops/cloud/host/bootstrap.sh"
