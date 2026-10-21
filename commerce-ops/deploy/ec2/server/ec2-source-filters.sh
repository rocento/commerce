#!/usr/bin/env bash
# Shared upload and activation boundary. Excludes also protect receiver files from deletion.
# Keep the scan inside deployment inputs. Public frontend assets remain included;
# demo images, docs, local workspaces and generated language research data do not.
# The language runtime uses the same two packaged inputs as deploy-ai.sh.
configure_source_filters() {
  SOURCE_FILTERS=(
    # Native mobile apps/specifications are not EC2 deployment inputs.
    --exclude='/commerce-mobile-apps/' --exclude='/rocento-mobile-specs/'
    --exclude='__pycache__/' --exclude='*.pyc'
    --exclude='.venv/' --exclude='.mypy_cache/' --exclude='.pytest_cache/' --exclude='.ruff_cache/'
    --exclude='.pnpm-store/' --exclude='playwright-report/' --exclude='test-results/' --exclude='*.tsbuildinfo'
    --exclude='.git/' --exclude='node_modules/' --exclude='target/' --exclude='dist/' --exclude='dist-server/' --exclude='out/' --exclude='.next/'
    --exclude='.stage*-dist/' --exclude='.stage*-dist-server/' --exclude='.DS_Store'
    --exclude='/Rocento-Codex/' --exclude='/commerce-api/rocento-api/migrations/' --exclude='.rsync-partial/'
    --exclude='/commerce-api/onboard-api/'
    --exclude='.env' --exclude='.env.*' --exclude='.local/' --exclude='artifacts/' --exclude='output/' --exclude='tmp/'
    --exclude='/commerce-assistant-platform/docs/' --exclude='/commerce-assistant-platform/evals/' --exclude='/commerce-assistant-platform/local/'
    --exclude='commerce-ops/deploy/ec2/bootstrap.env' --exclude='commerce-ops/deploy/ec2/*.env' --exclude='commerce-ops/deploy/ec2/state/' --exclude='commerce-ops/deploy/ec2/*.seeded' --exclude='commerce-ops/deploy/ec2/setup.lock'
    --exclude='/commerce-ops/deploy/ec2/public/' --exclude='/commerce-ops/deploy/ec2/shared-ai/'
    --exclude='/commerce-ops/deploy/ec2/card-details.*/'
    # Workstation launchers stay local; only the server implementations deploy.
    --exclude='/commerce-ops/deploy/aws-deploy/'
    --exclude='/commerce-ops/deploy/gcp-deploy/'
    --exclude='/commerce-ops/deploy/ec2/common.yaml' --exclude='/commerce-ops/deploy/ec2/grocery.yaml'
    --exclude='/commerce-ops/deploy/ec2/jewelry.yaml' --exclude='/commerce-ops/deploy/ec2/electronics.yaml' --exclude='/commerce-ops/deploy/ec2/pharmacy.yaml'
    --include='/commerce-ops/deploy/ec2/' --include='/commerce-ops/deploy/assistant/' --include='/commerce-ops/deploy/contact/'
    --include='/commerce-ops/deploy/health-dashboard/' --include='/commerce-ops/deploy/health-dashboard/***'
    --include='/commerce-ops/deploy/durability/' --include='/commerce-ops/deploy/observability/' --include='/commerce-ops/deploy/rengine/'
    --exclude='/commerce-ops/deploy/*'
    --include='/commerce-assistant-platform/app/commerce_language_engine/data/compiled.json'
    --include='/commerce-assistant-platform/app/commerce_language_engine/data/deployment-release.json.gz'
    --exclude='/commerce-assistant-platform/app/commerce_language_engine/data/*'
    --include='/commerce-api/' --include='/commerce-web/' --include='/commerce-assistant-platform/'
    --include='/commerce-ops/'
    --include='/commerce-ops/deploy/' --include='/commerce-ops/scripts/' --include='/commerce-ops/compose/'
    --exclude='/*'
  )
  if [[ ${PRESERVE_AI:-0} == 1 ]]; then
    SOURCE_FILTERS=(--exclude='/commerce-assistant-platform/' --exclude='/commerce-ops/deploy/assistant/'
      --exclude='/commerce-ops/compose/compose.assistant*.yaml' --exclude='/commerce-ops/compose/compose.language-engine.yaml' --exclude='/commerce-ops/compose/compose.ai-shared.yaml'
      --exclude='/commerce-ops/deploy/ec2/assistant.yaml' --exclude='/commerce-ops/deploy/ec2/shared-ai-consumer.yaml'
      "${SOURCE_FILTERS[@]}")
  fi
}

