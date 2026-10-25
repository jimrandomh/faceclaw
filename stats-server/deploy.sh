#!/bin/bash
# Deploys the stats server from this working tree to the VPS: copies the
# sources to ~/faceclaw-stats, installs dependencies and, once the one-time
# root setup (deploy/setup-server.sh) has been done, applies schema.sql and
# restarts the service. Set FACECLAW_STATS_HOST to deploy somewhere other
# than the `cumulus` ssh host.
set -euo pipefail
cd "$(dirname "$0")"
HOST="${FACECLAW_STATS_HOST:-cumulus}"
DIR=faceclaw-stats

rsync -az --delete --exclude node_modules --exclude .DS_Store ./ "$HOST:$DIR/"
ssh "$HOST" bash -s -- "$DIR" "$HOST" <<'REMOTE'
set -euo pipefail
cd "$HOME/$1"
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh" >/dev/null
nvm use 22 >/dev/null
npm ci --omit=dev --no-audit --no-fund --loglevel=error --no-update-notifier
if [ ! -f /etc/systemd/system/faceclaw-stats.service ]; then
  echo "Copied. Now run the one-time setup:  ssh -t $2 'sudo bash ~/$1/deploy/setup-server.sh'"
  exit 0
fi
set -a; . deploy/stats.env; set +a
psql -v ON_ERROR_STOP=1 -q -f schema.sql
# The service runs as this user with Restart=always, so ending the process
# restarts it on the new code without needing root.
pkill -TERM -u "$USER" -f "$PWD/src/server.ts" || true
sleep 3
systemctl is-active faceclaw-stats
curl -fsS "http://127.0.0.1:$PORT/healthz" && echo
REMOTE
