#!/usr/bin/env bash
# Compatibility entry point for installed EC2 server paths.
# Canonical rules live in commerce-ops/cloud/lib/source-filters.sh.
filter_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
filter_source="$filter_dir/../../shared/source-filters.sh"
if [[ ! -f $filter_source ]]; then
  # The /opt/rocento/deploy/ec2/server mirror sits outside commerce-ops/.
  filter_source="$filter_dir/../../../commerce-ops/cloud/lib/source-filters.sh"
fi
. "$filter_source"
unset filter_dir filter_source
