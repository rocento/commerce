#!/usr/bin/env bash
# Narrow upload and deployment of rengine on the existing Rocento host.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)
if [[ ${1:-} == --help ]]; then echo 'Usage: bash commerce-ops/cloud/providers/aws/deploy-rengine.sh'; exit 0; fi
[[ $# == 0 ]] || { echo 'Unknown option.' >&2; exit 2; }
. "$ROOT/commerce-ops/cloud/providers/aws/target.sh"
load_aws_target
HOST=$AWS_HOST
node "$ROOT/commerce-web/apps/rengine/pack-rules.mjs"
KEY="$ROOT/.local/commerce-ops/secrets/aws/rocento.pem"
SSH=(ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 "ubuntu@$HOST")
UPLOAD=$("${SSH[@]}" 'mktemp -d /home/ubuntu/.rocento-rengine.XXXXXXXX')
[[ $UPLOAD =~ ^/home/ubuntu/\.rocento-rengine\.[A-Za-z0-9]+$ ]] || exit 1
trap '"${SSH[@]}" "rm -rf -- '\''$UPLOAD'\''" >/dev/null 2>&1 || true' EXIT
COPYFILE_DISABLE=1 tar --no-xattrs -C "$ROOT" --exclude='node_modules' --exclude='.env*' --exclude='*.log' -czf - \
  commerce-ops/workflows/release/deployment_gate.py commerce-ops/workflows/release/release_readiness.py commerce-web/apps/rengine commerce-ops/compose/overlays/cloud/compose.rengine.yaml commerce-ops/services/rengine commerce-ops/cloud/host/deploy-rengine.sh commerce-ops/deploy/ec2/server/ec2-deploy-rengine.sh commerce-ops/deploy/ec2/server/repository-root.sh |
  "${SSH[@]}" "tar -xzf - -C '$UPLOAD'"
"${SSH[@]}" "sudo bash '$UPLOAD/commerce-ops/cloud/host/deploy-rengine.sh' --source '$UPLOAD'"
echo 'Verify https://rengine.rocento.com and sign in with the configured operator account to unlock saved demos.'
