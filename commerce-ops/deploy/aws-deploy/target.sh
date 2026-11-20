#!/usr/bin/env bash
# Compatibility loader for the former AWS provider path.
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
. "$ROOT/commerce-ops/cloud/providers/aws/target.sh"
