#!/usr/bin/env bash
# Compatibility wrapper; canonical launcher is commerce-ops/cloud/providers/aws/seed-demo.sh.
set -e
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
exec bash "$ROOT/commerce-ops/cloud/providers/aws/seed-demo.sh" "$@"
