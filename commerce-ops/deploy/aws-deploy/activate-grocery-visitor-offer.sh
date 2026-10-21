#!/usr/bin/env bash
# Activate only the requested grocery offer; never deploy or seed demos.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
case "${1:-}" in
  '') option= ;;
  --prepare) option=--prepare ;;
  *) printf 'Usage: bash commerce-ops/deploy/aws-deploy/activate-grocery-visitor-offer.sh [--prepare]\n' >&2; exit 1 ;;
esac
[[ $# -le 1 ]] || exit 1
ssh -i "$ROOT/commerce-ops/deploy/aws-deploy/rocento.pem" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
  ubuntu@3.78.102.161 "sudo -n python3 - $option" < "$ROOT/commerce-ops/scripts/demo/grocery-visitor-offer.py"
