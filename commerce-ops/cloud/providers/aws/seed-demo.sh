#!/usr/bin/env bash
# Resolve the AWS workstation target, then use the shared demo-seed workflow.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)
if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  exec bash "$ROOT/commerce-ops/cloud/seed-demo.sh" --provider aws --host help --key help --help
fi
. "$ROOT/commerce-ops/cloud/providers/aws/target.sh"
load_aws_target
KEY="$ROOT/.local/commerce-ops/secrets/aws/rocento.pem"
exec bash "$ROOT/commerce-ops/cloud/seed-demo.sh" --provider aws --host "$AWS_HOST" --key "$KEY" "$@"
