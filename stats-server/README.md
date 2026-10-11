# stats.faceclaw.org

Receives the opt-in analytics reports the phone app sends (format:
PROTOCOL.md) and stores them in Postgres. A small Node server with no
framework, behind nginx on the `cumulus` VPS.

    src/server.ts      HTTP server: POST /v1/report, GET /healthz
    src/report.ts      report validation
    src/db.ts          storing a report
    schema.sql         tables and views (idempotent, applied on every deploy)
    deploy.sh          deploy from this working tree
    deploy/            systemd unit, nginx site, env and one-time setup script

Node runs the TypeScript directly (type stripping, Node 22.18 or later), so
there is no build step. `npm run check` type-checks; `npm test` runs the
tests. The database test needs a scratch database:
`STATS_TEST_DATABASE=<name> npm test`, with the other `PG*` variables
pointing at its server.

## Deploying

    ./deploy.sh

copies this directory to `~/faceclaw-stats` on the server, installs the
dependencies, applies `schema.sql` and restarts the service. The first
time, it stops after copying, and the one-time root setup must be run there:

    ssh -t cumulus 'sudo bash ~/faceclaw-stats/deploy/setup-server.sh'

That creates a Postgres role named after the deploy user and the
`faceclaw_stats` database on the Postgres 16 cluster (port 5433; the older
14 cluster on 5432 is left alone), installs and starts
`faceclaw-stats.service`, adds the nginx site, and gets its certificate
with certbot. It is safe to rerun. The nginx site is only installed the first
time, since certbot edits it afterwards, so later changes to
`deploy/nginx-site.conf` have to be made on the server too.

The service runs as the deploy user with `Restart=always`, so `deploy.sh`
restarts it by ending the process, without needing root.

## Privacy

nginx keeps no access log for this site and the server stores only the
report body, so the database has no IP addresses. Reports carry a random
install id that the phone deletes when analytics is turned off.

## Looking at the data

    ssh cumulus psql -p 5433 faceclaw_stats

Views:

- `daily_counters`: counter totals per day, split by version, platform and
  build, with how many installs reported each.
- `latest_reports`: each install's most recent report.
- `latest_snapshot_values`: snapshot values across installs' latest reports.

For example, installs and connection failures per version over the last
week:

    select app_version, name, sum(total) as total, max(installs) as installs
    from daily_counters
    where day > current_date - 7 and name like 'g2.failure.%'
    group by 1, 2 order by 1, 3 desc;
