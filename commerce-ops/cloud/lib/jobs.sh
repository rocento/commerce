#!/usr/bin/env bash
# Shared job staging and monitoring for workstation launchers.
# The detached job controller and activation implementation live in cloud/host.

create_deployment_stage() {
  DEPLOY_JOB="$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
  UPLOAD="/home/$USER/.rocento-deploy/$DEPLOY_JOB"
  "${SSH[@]}" "install -d -m 700 '/home/$USER/.rocento-deploy' && mkdir -m 700 '$UPLOAD' && mkdir -m 700 '$UPLOAD/source' '$UPLOAD/config'"
}

# AWS reuses unchanged bytes with --copy-dest; GCP transfers the managed tree directly.
stage_managed_source() {
  local strategy=$1
  STAGE=source-upload
  case "$strategy" in
    copy-dest)
      stage_transfer "$REMOTE" "${SOURCE_FILTERS[@]}" "$ROOT/" "$USER@$HOST:$UPLOAD/source/"
      STAGE=migration-source-upload
      stage_transfer "$REMOTE/commerce-api/rocento-api/migrations" --delete \
        "$ROOT/commerce-api/rocento-api/migrations/" "$USER@$HOST:$UPLOAD/source/commerce-api/rocento-api/migrations/"
      ;;
    direct)
      retry_transfer rsync "${RSYNC_OPTIONS[@]}" --delete "${SOURCE_FILTERS[@]}" "$ROOT/" "$USER@$HOST:$UPLOAD/source/"
      STAGE=migration-source-upload
      retry_transfer rsync "${RSYNC_OPTIONS[@]}" --delete \
        "$ROOT/commerce-api/rocento-api/migrations/" "$USER@$HOST:$UPLOAD/source/commerce-api/rocento-api/migrations/"
      ;;
    *) printf 'ERROR: Unknown source transfer strategy: %s\n' "$strategy" >&2; return 2 ;;
  esac
}

# Monitoring can reconnect to an already launched job; it never launches it again.
monitor_deployment_job() {
  python3 "$ROOT/commerce-ops/cloud/host/deployment_job.py" monitor "$DEPLOY_JOB" \
    --source "$UPLOAD" --ssh "${MONITOR_SSH[@]}"
}
