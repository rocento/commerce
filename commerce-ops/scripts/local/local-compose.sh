#!/usr/bin/env bash
# One local project using the same service definitions as the EC2 stack.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
cd "$ROOT"
if [[ ! -f .env ]]; then
  echo 'Missing .env; copy .env.example to .env and configure local credentials.' >&2
  exit 1
fi
# Keep commerce-ai so existing local named volumes remain attached.
args=(--env-file .env -p commerce-ai -f commerce-ops/compose/compose.yaml -f commerce-ops/compose/compose.local-resources.yaml)
case "${1:-}" in
  --assistant)
    shift
    if [[ ! -f .local/assistant/local-compose.env ]]; then
      echo 'Initialize local shared AI storage: python3 commerce-ops/scripts/local/local-assistant-setup.py' >&2
      exit 1
    fi
    args+=(--env-file .local/assistant/local-compose.env -f commerce-ops/compose/compose.assistant.yaml -f commerce-ops/compose/compose.assistant-admin.yaml -f commerce-ops/compose/compose.language-engine.yaml -f commerce-ops/deploy/ec2/assistant.yaml -f commerce-ops/compose/compose.local.yaml)
    if [[ -f .local/assistant/all-demos-enabled ]]; then
      args+=(-f commerce-ops/compose/compose.local-shared-networks.yaml)
    fi
    ;;

esac
if [[ $# -eq 0 ]]; then
  echo 'Usage: commerce-ops/scripts/local/local-compose.sh [--assistant] <docker compose arguments>' >&2
  exit 2
fi
exec docker compose "${args[@]}" "$@"
