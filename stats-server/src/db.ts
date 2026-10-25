import type { Pool } from "pg";
import type { Report } from "./report.ts";

/**
 * Stores one report and its rows in a single transaction. The phone keeps
 * resending a report until it sees a 2xx, so a report id that is already
 * stored is a retry whose response was lost, not new data.
 */
export async function saveReport(pool: Pool, report: Report): Promise<"saved" | "duplicate"> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query(
      `insert into reports
         (report_id, install_id, created_at, schema_version, level, app_version, platform, build, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (report_id) do nothing`,
      [
        report.reportId,
        report.installId,
        report.createdAt,
        report.schema,
        report.level,
        report.app.version,
        report.app.platform,
        report.app.build,
        JSON.stringify(report),
      ],
    );
    if (inserted.rowCount === 0) {
      await client.query("rollback");
      return "duplicate";
    }

    const days: string[] = [];
    const names: string[] = [];
    const values: number[] = [];
    for (const [day, counts] of Object.entries(report.counters)) {
      for (const [name, value] of Object.entries(counts)) {
        days.push(day);
        names.push(name);
        values.push(value);
      }
    }
    if (names.length) {
      await client.query(
        `insert into report_counters (report_id, day, name, value)
         select $1, day::date, name, value from unnest($2::text[], $3::text[], $4::bigint[]) as t(day, name, value)`,
        [report.reportId, days, names, values],
      );
    }

    const keys = Object.keys(report.snapshot);
    if (keys.length) {
      await client.query(
        `insert into report_snapshot (report_id, key, value)
         select $1, key, value from unnest($2::text[], $3::jsonb[]) as t(key, value)`,
        [report.reportId, keys, keys.map((key) => JSON.stringify(report.snapshot[key]))],
      );
    }
    await client.query("commit");
    return "saved";
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
