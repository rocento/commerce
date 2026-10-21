#!/usr/bin/env bash
# Tenant-scoped local assistants backed by the existing shared AI database.
set -Eeuo pipefail
cd "$(dirname "$0")/../../.."
demo=${1:?Usage: local-demo-compose.sh grocery|jewelry|electronics|pharmacy <compose arguments>}
shift
if [[ "$demo" == grocery ]]; then exec bash commerce-ops/scripts/local/local-compose.sh --assistant "$@"; fi
case "$demo" in jewelry|electronics|pharmacy) ;; *) echo 'Unknown demo' >&2; exit 2;; esac
exec docker compose --env-file .env --env-file ".local/assistant-$demo/local-compose.env" -p "commerce-$demo" -f commerce-ops/compose/compose.yaml -f "commerce-ops/compose/compose.$demo.yaml" -f commerce-ops/compose/compose.assistant.yaml -f commerce-ops/compose/compose.assistant-admin.yaml -f commerce-ops/compose/compose.language-engine.yaml -f commerce-ops/deploy/ec2/assistant.yaml -f commerce-ops/deploy/ec2/shared-ai-consumer.yaml -f commerce-ops/compose/compose.local-resources.yaml "$@"
