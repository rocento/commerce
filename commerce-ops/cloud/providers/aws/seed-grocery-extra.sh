#!/usr/bin/env bash
# Preview or create the 15 additional grocery pack sizes through the EC2 API.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)
. "$ROOT/commerce-ops/cloud/providers/aws/target.sh"
case "${1:-}" in
  '') remote_args='' ;;
  --apply) remote_args='--apply' ;;
  *) echo 'Usage: bash commerce-ops/cloud/providers/aws/seed-grocery-extra.sh [--apply]' >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo 'Too many arguments' >&2; exit 2; }
load_aws_target
ssh -i "$ROOT/.local/commerce-ops/secrets/aws/rocento.pem" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20 \
  "ubuntu@$AWS_HOST" \
  "cd /opt/rocento && sudo python3 - $remote_args" \
  < "$ROOT/commerce-ops/workflows/demo/seed-grocery-extra-products.py"
