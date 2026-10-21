#!/usr/bin/env bash
# Keep this terminal open while using DBeaver; Ctrl+C closes the tunnel.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
PORT=15433
SHOW_PASSWORD=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT=${2:?Expected a local port}; shift 2 ;;
    --show-password) SHOW_PASSWORD=true; shift ;;
    -h|--help)
      echo 'Usage: bash commerce-ops/deploy/aws-deploy/assistant-db-tunnel.sh [--port 15433] [--show-password]'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ $PORT =~ ^[0-9]{1,5}$ ]] && ((10#$PORT >= 1024 && 10#$PORT <= 65535)) || {
  echo 'Choose a local port between 1024 and 65535.' >&2; exit 2;
}
PORT=$((10#$PORT))
SSH_OPTIONS=(-i "$ROOT/commerce-ops/deploy/aws-deploy/rocento.pem" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
HOST=ubuntu@3.78.102.161
IP=$(ssh "${SSH_OPTIONS[@]}" "$HOST" 'sudo -n docker inspect rocento-grocery-ai-postgres-1 --format "{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}"')
IP=$(printf '%s\n' "$IP" | awk 'NF {print; exit}')
[[ $IP =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || {
  echo 'Could not find the grocery assistant database container address.' >&2; exit 1;
}
printf '\nDBeaver → New connection → PostgreSQL\nHost: 127.0.0.1\nPort: %s\nDatabase: assistant\nUsername: ai_owner\nSSH tab: disabled (this script supplies the tunnel)\n' "$PORT"
if $SHOW_PASSWORD; then
  printf 'Password: '
  ssh "${SSH_OPTIONS[@]}" "$HOST" 'sudo -n docker exec rocento-grocery-ai-postgres-1 cat /run/secrets/ai-admin-password'
  printf '\n'
else
  echo 'Use --show-password to display the current database password.'
fi
echo 'Opening tunnel. Keep this terminal open; Ctrl+C disconnects. Port conflicts will exit with an error.'
exec ssh "${SSH_OPTIONS[@]}" -o ExitOnForwardFailure=yes -N -L "127.0.0.1:$PORT:$IP:5432" "$HOST"
