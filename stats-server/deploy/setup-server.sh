#!/bin/bash
# One-time root setup for the stats server on the VPS; safe to rerun. Run it
# via sudo, as the user that owns the deployed copy (deploy.sh puts it there):
#
#   ssh -t cumulus 'sudo bash ~/faceclaw-stats/deploy/setup-server.sh'
#
# It creates a Postgres role (named after that user, so the service and
# psql connect by peer auth) and the database on the cluster in stats.env,
# installs and starts the systemd service, adds the nginx site, and gets the
# site's Let's Encrypt certificate with certbot.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run this with sudo." >&2; exit 1; }
DEPLOY_USER="${SUDO_USER:?Run this via sudo from the user that owns the deployed copy.}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN=stats.faceclaw.org
set -a; . "$DIR/deploy/stats.env"; set +a
cd /

echo "== Postgres: role $DEPLOY_USER, database $PGDATABASE (port $PGPORT)"
pg_lsclusters --no-header | awk -v port="$PGPORT" '$3 == port && $4 == "online" { found = 1 } END { exit !found }' \
  || { echo "No online Postgres cluster on port $PGPORT." >&2; exit 1; }
sudo -u postgres psql -p "$PGPORT" -v ON_ERROR_STOP=1 -q -c \
  "do \$\$ begin if not exists (select from pg_roles where rolname = '$DEPLOY_USER') then create role \"$DEPLOY_USER\" login; end if; end \$\$;"
if ! sudo -u postgres psql -p "$PGPORT" -Atc "select 1 from pg_database where datname = '$PGDATABASE'" | grep -q 1; then
  sudo -u postgres createdb -p "$PGPORT" -O "$DEPLOY_USER" "$PGDATABASE"
fi
sudo -u "$DEPLOY_USER" psql -h "$PGHOST" -p "$PGPORT" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q -f "$DIR/schema.sql"

echo "== systemd: faceclaw-stats.service"
[ -d "$DIR/node_modules" ] || { echo "No node_modules in $DIR; run deploy.sh first." >&2; exit 1; }
sed -e "s|@USER@|$DEPLOY_USER|g" -e "s|@DIR@|$DIR|g" "$DIR/deploy/faceclaw-stats.service" \
  > /etc/systemd/system/faceclaw-stats.service
systemctl daemon-reload
systemctl enable faceclaw-stats.service
systemctl restart faceclaw-stats.service

echo "== nginx: $DOMAIN"
SITE="/etc/nginx/sites-available/$DOMAIN"
# certbot edits the installed copy, so only install it the first time.
[ -e "$SITE" ] || cp "$DIR/deploy/nginx-site.conf" "$SITE"
ln -sf "$SITE" "/etc/nginx/sites-enabled/$DOMAIN"
if ! nginx -t; then
  # Don't leave a broken site enabled: it would block reloads for every site.
  rm -f "/etc/nginx/sites-enabled/$DOMAIN"
  echo "nginx rejected the site config; it has been disabled again." >&2
  exit 1
fi
systemctl reload nginx

echo "== TLS certificate"
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --redirect
fi

echo "== Checking https://$DOMAIN/healthz"
sleep 2
curl -fsS "https://$DOMAIN/healthz" && echo
