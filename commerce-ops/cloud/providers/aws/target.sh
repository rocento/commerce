#!/usr/bin/env bash
# Read the normalized AWS target without evaluating local configuration.

load_aws_target() {
  local target_file line key value provider_seen=0 user_seen=0
  target_file="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)/.local/commerce-ops/targets/production-aws.env"
  AWS_HOST=${ROCENTO_AWS_HOST:-}
  if [[ -z $AWS_HOST ]]; then
    [[ -f $target_file && ! -L $target_file ]] || {
      printf 'ERROR: Missing %s; create it with PROVIDER=aws and HOST=hostname-or-ip.\n' "$target_file" >&2
      return 1
    }
    while IFS= read -r line || [[ -n $line ]]; do
      [[ -z $line || ${line:0:1} == '#' ]] && continue
      [[ $line == *=* ]] || {
        printf 'ERROR: Invalid line in %s. Use KEY=value.\n' "$target_file" >&2
        return 1
      }
      key=${line%%=*}
      value=${line#*=}
      [[ -n $value && $value == "${value# }" && $value == "${value% }" ]] || {
        printf 'ERROR: Invalid value for %s in %s.\n' "$key" "$target_file" >&2
        return 1
      }
      case "$key" in
        PROVIDER) [[ $value == aws && $provider_seen == 0 ]] || { printf 'ERROR: Target PROVIDER must be aws.\n' >&2; return 1; }; provider_seen=1 ;;
        HOST) [[ -z $AWS_HOST ]] || { printf 'ERROR: Duplicate HOST in %s.\n' "$target_file" >&2; return 1; }; AWS_HOST=$value ;;
        SSH_USER) [[ $value == ubuntu && $user_seen == 0 ]] || { printf 'ERROR: Target SSH_USER must be ubuntu.\n' >&2; return 1; }; user_seen=1 ;;
        *) printf 'ERROR: Unsupported target field in %s: %s\n' "$target_file" "$key" >&2; return 1 ;;
      esac
    done < "$target_file"
    [[ $provider_seen == 1 ]] || { printf 'ERROR: Target must set PROVIDER=aws.\n' >&2; return 1; }
  fi
  [[ $AWS_HOST =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ && $AWS_HOST != *..* && $AWS_HOST != *. ]] || {
    printf 'ERROR: AWS HOST must be a hostname or IPv4 address.\n' >&2
    return 1
  }
}
