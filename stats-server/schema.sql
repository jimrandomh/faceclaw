-- Schema for the analytics reports (PROTOCOL.md). Idempotent: deploy.sh
-- applies it on every deploy, so changes must be written as additive
-- `if not exists` / `create or replace` statements.

create table if not exists reports (
  report_id uuid primary key,
  install_id uuid not null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null,
  schema_version integer not null,
  level text not null,
  app_version text not null,
  platform text not null,
  build text not null,
  -- The validated report as received, for anything the tables below don't cover.
  payload jsonb not null
);
create index if not exists reports_received_at_idx on reports (received_at);
create index if not exists reports_install_idx on reports (install_id, received_at);

create table if not exists report_counters (
  report_id uuid not null references reports (report_id) on delete cascade,
  day date not null,
  name text not null,
  value bigint not null,
  primary key (report_id, day, name)
);
create index if not exists report_counters_day_name_idx on report_counters (day, name);

create table if not exists report_snapshot (
  report_id uuid not null references reports (report_id) on delete cascade,
  key text not null,
  value jsonb not null,
  primary key (report_id, key)
);

-- Counter totals per day, split by version, platform and build, with how
-- many installs reported each.
create or replace view daily_counters as
select r.app_version, r.platform, r.build, c.day, c.name,
       sum(c.value) as total, count(distinct r.install_id) as installs
from report_counters c
join reports r using (report_id)
group by r.app_version, r.platform, r.build, c.day, c.name;

-- Each install's most recent report.
create or replace view latest_reports as
select distinct on (install_id) *
from reports
order by install_id, received_at desc;

-- Snapshot values from each install's most recent report, counted.
create or replace view latest_snapshot_values as
select r.app_version, r.platform, s.key, s.value, count(*) as installs
from latest_reports r
join report_snapshot s using (report_id)
group by r.app_version, r.platform, s.key, s.value;
