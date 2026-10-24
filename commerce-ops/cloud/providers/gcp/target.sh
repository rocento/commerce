#!/usr/bin/env bash
# Parse normalized GCP target data without evaluating shell expressions.
# Callers decide when to load CONFIG; existing values take precedence.
# Requires fail(), CONFIG and initialized HOST/SSH_KEY/PROJECT/ZONE/INSTANCE.
load_gcp_target() {
  [[ -f $CONFIG && ! -L $CONFIG ]] || fail "Target must be a regular file: $CONFIG"
  # Read normalized KEY=value settings without evaluating them as shell code.
  local line key value seen_target_fields="|" provider_seen=0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || ${line:0:1} == '#' ]] && continue
    [[ $line == *=* ]] || fail "Invalid target setting in $CONFIG; use KEY=value."
    key=${line%%=*}; value=${line#*=}
    [[ -n $value && $value == "${value# }" && $value == "${value% }" && "$seen_target_fields" != *"|$key|"* ]] || fail "Invalid or duplicate target field: $key"
    seen_target_fields="${seen_target_fields}${key}|"
    case "$key" in
      PROVIDER) [[ $value == gcp ]] || fail 'The selected target must set PROVIDER=gcp.'; provider_seen=1 ;;
      SSH_USER) [[ $value == ubuntu ]] || fail 'The current host commands require SSH_USER=ubuntu.' ;;
      HOST) HOST=${HOST:-$value} ;;
      SSH_KEY) SSH_KEY=${SSH_KEY:-$value} ;;
      PROJECT) PROJECT=${PROJECT:-$value} ;;
      ZONE) ZONE=${ZONE:-$value} ;;
      INSTANCE) INSTANCE=${INSTANCE:-$value} ;;
      *) fail "Unsupported target field: $key" ;;
    esac
  done < "$CONFIG"
  [[ $provider_seen == 1 ]] || fail 'The selected target must set PROVIDER=gcp.'
}
