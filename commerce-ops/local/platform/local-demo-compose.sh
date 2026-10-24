#!/usr/bin/env bash
# Tenant-scoped local assistants backed by the existing shared AI database.
set -Eeuo pipefail
cd "$(dirname "$0")/../../.."
demo=${1:?Usage: local-demo-compose.sh grocery|jewelry|electronics|pharmacy <compose arguments>}
shift
if [[ "$demo" == grocery ]]; then exec bash commerce-ops/local/platform/local-compose.sh --assistant "$@"; fi
case "$demo" in jewelry|electronics|pharmacy) ;; *) echo 'Unknown demo' >&2; exit 2;; esac
exec docker compose --project-directory commerce-ops/compose --env-file .env --env-file ".local/assistant-$demo/local-compose.env" -p "commerce-$demo" -f commerce-ops/compose/base/compose.yaml -f "commerce-ops/compose/overlays/demos/compose.$demo.yaml" -f commerce-ops/compose/components/compose.assistant.yaml -f commerce-ops/compose/components/compose.assistant-admin.yaml -f commerce-ops/compose/components/compose.language-engine.yaml -f commerce-ops/compose/components/compose.assistant-runtime.yaml -f commerce-ops/compose/components/compose.shared-ai-consumer.yaml -f commerce-ops/compose/overlays/local/compose.local-resources.yaml "$@"
