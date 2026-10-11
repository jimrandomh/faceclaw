import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReport, ReportError } from "../src/report.ts";
import { sampleReport } from "./sample.ts";

void test("accepts a well-formed report and normalizes ids and timestamps", () => {
  const report = parseReport(
    sampleReport({ reportId: "0F8FAD5B-D9CB-469F-A165-70867728950E", createdAt: "2026-10-10T08:00:00-04:00" }),
  );
  assert.equal(report.reportId, "0f8fad5b-d9cb-469f-a165-70867728950e");
  assert.equal(report.createdAt, "2026-10-10T12:00:00.000Z");
  assert.deepEqual(report.counters["2026-10-09"], { "g2.connect": 3, "g2.disconnect": 2 });
  assert.equal(report.snapshot["setting.ui-font"], "Roboto-Light.ttf:16");
});

void test("accepts camelCase snapshot keys but only lowercase counter names", () => {
  assert.equal(parseReport(sampleReport({ snapshot: { "setting.display.timeFormat": "12h" } })).snapshot["setting.display.timeFormat"], "12h");
  assert.throws(() => parseReport(sampleReport({ counters: { "2026-10-10": { "g2.Connect": 1 } } })), ReportError);
});

void test("ignores unknown fields", () => {
  const report = parseReport(sampleReport({ extra: "x" }));
  assert.equal("extra" in report, false);
});

void test("rejects malformed reports", () => {
  const bad: Record<string, unknown>[] = [
    { schema: 2 },
    { level: "everything" },
    { reportId: "not-a-uuid" },
    { app: { version: "0.8.3; drop table", platform: "android", build: "official" } },
    { app: { version: "0.8.3", platform: "Android", build: "official" } },
    { createdAt: "yesterday" },
    { counters: { "2026-13-45": { a: 1 } } },
    { counters: { "2026-10-10": { "Bad Name": 1 } } },
    { counters: { "2026-10-10": { a: -1 } } },
    { counters: { "2026-10-10": { a: 1.5 } } },
    { counters: [] },
    { snapshot: { a: { nested: true } } },
    { snapshot: { "bad key": true } },
    { snapshot: { a: "x".repeat(201) } },
    { snapshot: { a: Number.NaN } },
  ];
  for (const overrides of bad) {
    assert.throws(() => parseReport(sampleReport(overrides)), ReportError, JSON.stringify(overrides));
  }
  assert.throws(() => parseReport(null), ReportError);
  assert.throws(() => parseReport([]), ReportError);
});

void test("caps how many counters and snapshot keys a report may carry", () => {
  const manyDays: Record<string, Record<string, number>> = {};
  for (let day = 0; day < 101; day++) {
    manyDays[new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10)] = { a: 1 };
  }
  assert.throws(() => parseReport(sampleReport({ counters: manyDays })), /too many days/);

  const manyKeys: Record<string, boolean> = {};
  for (let index = 0; index < 501; index++) manyKeys[`k${index}`] = true;
  assert.throws(() => parseReport(sampleReport({ snapshot: manyKeys })), /too many snapshot keys/);
});
