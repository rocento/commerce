#!/usr/bin/env bash
# Shared Compose command for deployed Rocento stores.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
store=${1:-}
case "$store" in
  grocery|jewelry|electronics|pharmacy) shift ;;
  *) echo "Usage: $0 {grocery|jewelry|electronics|pharmacy} <docker compose arguments>" >&2; exit 2 ;;
esac
cd "$ROOT"
if [[ ! -f "deploy/ec2/$store.env" || ! -f deploy/ec2/common.yaml ]]; then
  echo 'Missing deployment configuration. Run sudo bash deploy/ec2/server/ec2-up.sh first.' >&2
  exit 1
fi
[[ -f "deploy/ec2/$store-assistant.env" ]] || { echo 'Missing assistant identity. Run deploy/ec2/server/ec2-up.sh to provision it.' >&2; exit 1; }
args=(--project-directory commerce-ops/compose --env-file "deploy/ec2/$store.env" --env-file "deploy/ec2/$store-assistant.env" -p "rocento-$store" -f commerce-ops/compose/base/compose.yaml)
[[ $store == grocery ]] || args+=(-f "commerce-ops/compose/overlays/demos/compose.$store.yaml")
args+=(-f commerce-ops/compose/components/compose.assistant.yaml -f commerce-ops/compose/components/compose.assistant-admin.yaml -f deploy/ec2/common.yaml -f "deploy/ec2/$store.yaml" -f commerce-ops/compose/components/compose.assistant-runtime.yaml)
args+=(-f commerce-ops/compose/components/compose.language-engine.yaml)
if [[ -f "deploy/ec2/$store-shared-ai.env" ]]; then
  args+=(--env-file "deploy/ec2/$store-shared-ai.env" -f commerce-ops/compose/components/compose.shared-ai-consumer.yaml)
fi
exec docker compose "${args[@]}" "$@"
