# Shared checkout discovery for canonical source and the /opt/rocento mirror.
find_repo_root() {
  local candidate
  candidate=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  while [[ "$candidate" != / ]]; do
    if [[ -f "$candidate/commerce-api/rocento-api/Cargo.toml" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
    candidate=$(dirname -- "$candidate")
  done
  echo 'ERROR: Cannot locate the commerce repository root.' >&2
  return 1
}
