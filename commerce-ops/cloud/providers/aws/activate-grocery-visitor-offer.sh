#!/usr/bin/env bash
# Activate only the requested grocery offer; never deploy or seed demos.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)
. "$ROOT/commerce-ops/cloud/providers/aws/target.sh"
case "${1:-}" in
  '') option= ;;
  --prepare) option=--prepare ;;
  *) printf 'Usage: bash commerce-ops/cloud/providers/aws/activate-grocery-visitor-offer.sh [--prepare]\n' >&2; exit 1 ;;
esac
[[ $# -le 1 ]] || exit 1
load_aws_target
ssh -i "$ROOT/.local/commerce-ops/secrets/aws/rocento.pem" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
  "ubuntu@$AWS_HOST" "sudo -n python3 - $option" < "$ROOT/commerce-ops/workflows/demo/grocery-visitor-offer.py"
