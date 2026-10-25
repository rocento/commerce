#!/usr/bin/env bash
# Shared workstation transport behavior. Callers own targets and staging.

# Configure a private SSH connection and rsync for one provider target.
# Arguments: key, archive option, temporary-directory prefix, identities-only (0/1), dry-run (0/1).
configure_workstation_transport() {
  local key=$1 archive_option=$2 temporary_prefix=$3 identities_only=$4 dry_run=$5
  TRANSPORT_DIR=$(mktemp -d "/tmp/$temporary_prefix.XXXXXX")
  chmod 700 "$TRANSPORT_DIR"
  SSH_OPTIONS=(-i "$key" -o BatchMode=yes)
  if (( identities_only )); then SSH_OPTIONS+=(-o IdentitiesOnly=yes); fi
  SSH_OPTIONS+=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20
    -o ConnectionAttempts=3 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
    -o ControlMaster=auto -o ControlPersist=120 -o "ControlPath=$TRANSPORT_DIR/control")
  SSH=(ssh "${SSH_OPTIONS[@]}" "$USER@$HOST")
  SCP=(scp "${SSH_OPTIONS[@]}")
  RSYNC_SSH="ssh -i \"$key\" -o BatchMode=yes"
  if (( identities_only )); then RSYNC_SSH+=' -o IdentitiesOnly=yes'; fi
  RSYNC_SSH+=" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o ConnectionAttempts=3 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ControlMaster=auto -o ControlPersist=120 -o ControlPath=$TRANSPORT_DIR/control"
  RSYNC_OPTIONS=("$archive_option" --partial --partial-dir=.rsync-partial --timeout=120 --stats
    --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r -e "$RSYNC_SSH")
  if (( dry_run )); then
    RSYNC_OPTIONS+=(--dry-run --itemize-changes)
  else
    RSYNC_OPTIONS+=(--progress)
  fi
  MONITOR_SSH=(ssh -i "$key" -o BatchMode=yes)
  if (( identities_only )); then MONITOR_SSH+=(-o IdentitiesOnly=yes); fi
  MONITOR_SSH+=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20
    -o ConnectionAttempts=3 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
    -o ControlMaster=no -o ControlPath=none "$USER@$HOST")
}

reset_transfer_connection() {
  [[ -n ${TRANSPORT_DIR:-} ]] || return 0
  ssh -o BatchMode=yes -S "$TRANSPORT_DIR/control" -O exit "$USER@$HOST" >/dev/null 2>&1 || true
  rm -f -- "$TRANSPORT_DIR/control" || true
}

# Close the workstation control connection and remove its private socket directory.
# Callers retain EXIT traps and provider-specific diagnostics.
close_workstation_transport() {
  [[ -n ${TRANSPORT_DIR:-} ]] || return 0
  reset_transfer_connection
  rm -rf -- "$TRANSPORT_DIR"
}

# Retry only transport failures. Never retry remote activation or data changes.
retry_transfer() {
  local attempt status
  for attempt in 1 2 3; do
    if "$@"; then return 0; else status=$?; fi
    case "$status" in
      10|12|30|35|255) ;;
      *) return "$status" ;;
    esac
    (( attempt < 3 )) || return "$status"
    printf '[INFO] SSH/transfer interrupted (exit %s); reconnecting and retrying %s/3.\n' "$status" "$((attempt + 1))"
    reset_transfer_connection
    sleep 2
  done
}
