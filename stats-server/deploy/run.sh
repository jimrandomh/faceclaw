#!/bin/bash
# Started by faceclaw-stats.service, with deploy/stats.env in the environment.
# Node comes from nvm, as for the other services on this host.
cd "$(dirname "$0")/.."
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 22 >/dev/null
# The absolute path lets deploy.sh find this process to restart it.
exec node "$PWD/src/server.ts"
