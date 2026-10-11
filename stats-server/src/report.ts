/**
 * The analytics report format the phone app uploads (PROTOCOL.md), and its
 * validation. The app-side producer is app/analytics/analytics-report.ts;
 * keep the two in step.
 *
 * Everything is checked against tight limits so a malformed or hostile
 * client can't store much: unknown fields are ignored, and anything
 * out of range rejects the whole report.
 */

export const REPORT_SCHEMA_VERSION = 1;

export type ReportLevel = "minimal" | "full";
export type SnapshotValue = boolean | number | string;

export interface Report {
  schema: number;
  reportId: string;
  installId: string;
  level: ReportLevel;
  /** When the phone sealed the report (ISO 8601). */
  createdAt: string;
  app: { version: string; platform: string; build: string };
  /** UTC day (YYYY-MM-DD) → counter name → count. */
  counters: Record<string, Record<string, number>>;
  /** Point-in-time state (devices, API-key presence, settings), flat namespaced keys. */
  snapshot: Record<string, SnapshotValue>;
}

export class ReportError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const TOKEN = /^[a-z0-9-]{1,24}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const COUNTER_NAME = /^[a-z0-9][a-z0-9_.:-]{0,119}$/;
// Snapshot keys embed the app's settings keys, which are camelCase.
const SNAPSHOT_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

const MAX_DAYS = 100;
const MAX_COUNTERS = 2000;
const MAX_COUNT = 1_000_000_000;
const MAX_SNAPSHOT_KEYS = 500;
const MAX_SNAPSHOT_STRING = 200;

export function parseReport(value: unknown): Report {
  const body = record(value, "report");
  if (body.schema !== REPORT_SCHEMA_VERSION) throw new ReportError(`unsupported schema ${String(body.schema)}`);
  const level = body.level;
  if (level !== "minimal" && level !== "full") throw new ReportError("bad level");
  const app = record(body.app, "app");
  return {
    schema: REPORT_SCHEMA_VERSION,
    reportId: uuid(body.reportId, "reportId"),
    installId: uuid(body.installId, "installId"),
    level,
    createdAt: timestamp(body.createdAt, "createdAt"),
    app: {
      version: matching(app.version, VERSION, "app.version"),
      platform: matching(app.platform, TOKEN, "app.platform"),
      build: matching(app.build, TOKEN, "app.build"),
    },
    counters: counters(body.counters ?? {}),
    snapshot: snapshot(body.snapshot ?? {}),
  };
}

function counters(value: unknown): Report["counters"] {
  const days = record(value, "counters");
  const dayKeys = Object.keys(days);
  if (dayKeys.length > MAX_DAYS) throw new ReportError("too many days");
  const result: Report["counters"] = {};
  let total = 0;
  for (const day of dayKeys) {
    if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new ReportError(`bad day ${day}`);
    const entries = record(days[day], `counters.${day}`);
    const counts: Record<string, number> = {};
    for (const [name, count] of Object.entries(entries)) {
      if (!COUNTER_NAME.test(name)) throw new ReportError(`bad counter name ${name}`);
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > MAX_COUNT) {
        throw new ReportError(`bad count for ${name}`);
      }
      if (++total > MAX_COUNTERS) throw new ReportError("too many counters");
      counts[name] = count;
    }
    result[day] = counts;
  }
  return result;
}

function snapshot(value: unknown): Report["snapshot"] {
  const entries = Object.entries(record(value, "snapshot"));
  if (entries.length > MAX_SNAPSHOT_KEYS) throw new ReportError("too many snapshot keys");
  const result: Report["snapshot"] = {};
  for (const [key, item] of entries) {
    if (!SNAPSHOT_KEY.test(key)) throw new ReportError(`bad snapshot key ${key}`);
    const ok =
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item)) ||
      (typeof item === "string" && item.length <= MAX_SNAPSHOT_STRING);
    if (!ok) throw new ReportError(`bad snapshot value for ${key}`);
    result[key] = item;
  }
  return result;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ReportError(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function uuid(value: unknown, what: string): string {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (!UUID.test(text)) throw new ReportError(`bad ${what}`);
  return text;
}

function matching(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new ReportError(`bad ${what}`);
  return value;
}

function timestamp(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length > 40 || Number.isNaN(Date.parse(value))) throw new ReportError(`bad ${what}`);
  return new Date(value).toISOString();
}
