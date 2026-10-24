#!/usr/bin/env bash
# Called under the deployment lock after reviewed shared images are preloaded.
set -Eeuo pipefail
ROOT=${ROCENTO_DEPLOY_ROOT:-/opt/rocento}
SERVICE=${1:-all}
DATABASE=rocento-ai-shared-ai-postgres-1
[[ -s "$ROOT/deploy/ec2/shared-ai/language-owner.env" ]] || { echo 'Shared AI operator credentials missing' >&2; exit 1; }
if [[ $SERVICE != language ]]; then
  python3 "$ROOT/commerce-ops/services/assistant/conversations-setup.py" --container "$DATABASE"
fi
if [[ $SERVICE != ai ]]; then
  docker run --rm --network rocento-grocery_assistant-private \
    --env-file "$ROOT/deploy/ec2/shared-ai/language-owner.env" \
    rocento-language-engine:release node scripts/deploy-start.ts --migrate-only
  docker exec -i "$DATABASE" psql -X -U ai_owner -d commerce_language -v ON_ERROR_STOP=1 \
    < "$ROOT/commerce-ops/services/assistant/shared-language-tenants.sql"
  # Candidate import/evaluation/promotion is an explicit operator workflow.
  # Refuse a mismatched image before the surrounding deploy replaces services.
  docker run --rm --network rocento-grocery_assistant-private \
    --env-file "$ROOT/deploy/ec2/shared-ai/language-owner.env" \
    rocento-language-engine:release node scripts/deploy-start.ts --verify-only
fi
