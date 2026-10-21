#!/usr/bin/env bash
# Narrow upload and deployment of rengine on the existing Rocento host.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
if [[ ${1:-} == --help ]]; then echo 'Usage: bash commerce-ops/deploy/aws-deploy/deploy-rengine.sh'; exit 0; fi
[[ $# == 0 ]] || { echo 'Unknown option.' >&2; exit 2; }
node "$ROOT/commerce-web/apps/rengine/pack-rules.mjs"
HOST=3.78.102.161
KEY="$ROOT/commerce-ops/deploy/aws-deploy/rocento.pem"
SSH=(ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 "ubuntu@$HOST")
UPLOAD=$("${SSH[@]}" 'mktemp -d /home/ubuntu/.rocento-rengine.XXXXXXXX')
[[ $UPLOAD =~ ^/home/ubuntu/\.rocento-rengine\.[A-Za-z0-9]+$ ]] || exit 1
trap '"${SSH[@]}" "rm -rf -- '\''$UPLOAD'\''" >/dev/null 2>&1 || true' EXIT
COPYFILE_DISABLE=1 tar --no-xattrs -C "$ROOT" --exclude='node_modules' --exclude='.env*' --exclude='*.log' -czf - \
  commerce-ops/scripts/release/deployment_gate.py commerce-ops/scripts/release/release_readiness.py commerce-web/apps/rengine commerce-ops/compose/compose.rengine.yaml commerce-ops/deploy/rengine commerce-ops/deploy/ec2/server/ec2-deploy-rengine.sh |
  "${SSH[@]}" "tar -xzf - -C '$UPLOAD'"
"${SSH[@]}" "sudo bash '$UPLOAD/commerce-ops/deploy/ec2/server/ec2-deploy-rengine.sh' --source '$UPLOAD'"
echo 'Verify https://rengine.rocento.com and sign in with the configured operator account to unlock saved demos.'
