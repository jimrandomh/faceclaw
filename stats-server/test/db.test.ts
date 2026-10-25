import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Pool } from "pg";
import { saveReport } from "../src/db.ts";
import { parseReport } from "../src/report.ts";
import { sampleReport } from "./sample.ts";

// Needs a scratch database: set STATS_TEST_DATABASE to its name (the other
// PG* variables pick the server). The tables are created if missing, and
// emptied before the test.
const database = process.env.STATS_TEST_DATABASE;

void test("stores a report once, with its counters and snapshot", { skip: !database && "STATS_TEST_DATABASE not set" }, async () => {
  const pool = new Pool({ database });
  try {
    await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
    await pool.query("truncate reports cascade");

    const report = parseReport(sampleReport());
    assert.equal(await saveReport(pool, report), "saved");
    assert.equal(await saveReport(pool, report), "duplicate");

    const counters = await pool.query(
      "select day::text, name, value::int from report_counters order by day, name",
    );
    assert.deepEqual(counters.rows, [
      { day: "2026-10-09", name: "g2.connect", value: 3 },
      { day: "2026-10-09", name: "g2.disconnect", value: 2 },
      { day: "2026-10-10", name: "g2.connect", value: 1 },
    ]);
    const snapshot = await pool.query("select key, value from report_snapshot order by key");
    assert.deepEqual(snapshot.rows, [
      { key: "apikey.anthropic", value: false },
      { key: "device.g2.paired", value: true },
      { key: "setting.ui-font", value: "Roboto-Light.ttf:16" },
    ]);
    const daily = await pool.query("select total::int, installs::int from daily_counters where name = 'g2.connect' and day = '2026-10-09'");
    assert.deepEqual(daily.rows, [{ total: 3, installs: 1 }]);
  } finally {
    await pool.end();
  }
});
