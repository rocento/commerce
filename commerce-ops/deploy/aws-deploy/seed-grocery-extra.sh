#!/usr/bin/env bash
# Preview or create the 15 additional grocery pack sizes through the EC2 API.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
case "${1:-}" in
  '') remote_args='' ;;
  --apply) remote_args='--apply' ;;
  *) echo 'Usage: bash commerce-ops/deploy/aws-deploy/seed-grocery-extra.sh [--apply]' >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo 'Too many arguments' >&2; exit 2; }
ssh -i "$ROOT/commerce-ops/deploy/aws-deploy/rocento.pem" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20 \
  ubuntu@3.78.102.161 \
  "cd /opt/rocento && sudo python3 - $remote_args" \
  < "$ROOT/commerce-ops/scripts/demo/seed-grocery-extra-products.py"
