/**
 * Durable local storage for decoded ring health records.
 *
 * ## Why this exists at all, and why it is not a cache
 *
 * Live testing on 2026-09-10 found that the ring appears to advance its own
 * delivery watermark when it sends the RSP to a health request, whether or not
 * the DATA page that should follow ever arrives - so a request that loses the
 * race can PERMANENTLY DISCARD backlog, silently, with no error anywhere in
 * the protocol (implement-return, section 11). The practical consequence:
 * the moment a record is successfully decoded may be the only moment it is
 * ever available. It has to hit durable storage right then.
 *
 * The existing `ringHealthRecords` list on `FaceclawBleCommunicator` is
 * explicitly a capped, ephemeral ring buffer (256 records, oldest dropped) and
 * is not a store. This is the store.
 *
 * ## The layout, and why it is shaped this way
 *
 *   health/samples-YYYY-MM.jsonl   append-only, one JSON object per line
 *   health/sleep.jsonl             append-only, one session per line
 *   health/rollups.json            DERIVED daily rollups - a rebuildable cache
 *
 * The raw shards are the truth and are never rewritten in place, only appended
 * to. That is the property the paragraph above demands: a crash, a bad parse,
 * or a bug in the rollup code can never destroy a record that was once
 * received, because nothing ever rewrites the file that holds it.
 *
 * `rollups.json` is the answer to "pre-aggregate on write, or aggregate on
 * render?" - and the answer is BOTH, at different layers, because they are
 * asked by different screens:
 *
 *   - The glasses glance and the by-hour charts want one day at fine
 *     resolution. That comes from raw shards, aggregated on render. At ~360
 *     samples a day the work is trivial, and it stays exact.
 *   - The by-day charts want weeks or months. Aggregating those on render
 *     means parsing every shard in the range - about 9 MB a year of JSONL, and
 *     growing without bound. So daily rollups are maintained on write and
 *     served straight from this one small file, and a quarter-long chart never
 *     opens a shard at all.
 *
 * Because the rollup file is derived, it carries no risk: if it is missing,
 * corrupt, or written by an older version, `rebuildRollups()` regenerates it
 * from the shards. Deleting it is always safe.
 *
 * ## No new dependency
 *
 * SQLite is not a dependency of this project and adding one for this would be
 * the largest change in the feature. Everything the phone view needs is a
 * key-ordered scan over a few tens of thousands of rows, which is what the
 * above does with the `File` API already used by `open-apps-persistence.ts`
 * for the same kind of job.
 *
 * This module has NO NativeScript imports - the filesystem arrives through
 * `HealthStorageBackend` - so its durability and dedupe semantics run under
 * plain node in `tests/health-store.test.cjs`. The real backend is
 * `health-store-files.ts`.
 */

import {
  type HealthSample,
  type Rollup,
  type SampleMetric,
  type SleepSession,
  SAMPLE_METRICS,
  monthKey,
  rollupOf,
  startOfLocalDay,
} from "./health-types";

export interface HealthStorageBackend {
  exists(name: string): boolean;
  read(name: string): string | null;
  /** Must create the file if absent. Durable before returning. */
  append(name: string, text: string): void;
  write(name: string, text: string): void;
  /** Every file in the health folder. Used to rebuild the rollup cache. */
  list(): string[];
}

const SAMPLE_PREFIX = "samples-";
const SAMPLE_SUFFIX = ".jsonl";
const SLEEP_FILE = "sleep.jsonl";
const ROLLUP_FILE = "rollups.json";
const ROLLUP_VERSION = 1;

/** On-disk sample line. Short keys: this is the file that grows. */
type SampleLine = {
  m: SampleMetric;
  t: number;
  s: number;
  n: number;
  x: number;
  a: number;
  u: number;
};

type RollupFile = {
  version: number;
  /** `YYYY-MM-DD` -> metric -> rollup. */
  days: Record<string, Partial<Record<SampleMetric, Rollup>>>;
};

function sampleKey(sample: { metric: SampleMetric; startMs: number; spanMs: number }): string {
  return `${sample.metric}|${sample.startMs}|${sample.spanMs}`;
}

function dayKey(ms: number): string {
  const date = new Date(startOfLocalDay(ms));
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function shardName(ms: number): string {
  return `${SAMPLE_PREFIX}${monthKey(ms)}${SAMPLE_SUFFIX}`;
}

export class HealthStore {
  /** Shard name -> dedupe key -> sample. Loaded lazily, per shard. */
  private readonly shards = new Map<string, Map<string, HealthSample>>();
  private sleep: SleepSession[] | null = null;
  private rollups: RollupFile | null = null;

  constructor(private readonly backend: HealthStorageBackend) {}

  // -------------------------------------------------------------------------
  // Writing

  /**
   * Store decoded samples. Durable before this returns.
   *
   * Returns how many were genuinely new or changed. Re-storing a bucket that
   * is already held is a no-op on disk, which matters because the live poller
   * re-requests the current hour every 30 minutes and would otherwise append a
   * duplicate line each time.
   *
   * ## This no-op is real, and it is the ONLY place it needs to be
   *
   * Re-checked 2026-09-12 while chasing a shard that reached 22k lines in a
   * day. The suspicion was that identical re-writes were being appended; they
   * were not. `sameSample` below compares every stored field, `spanMs` is part
   * of the key, and an unchanged sample never reaches `append`.
   *
   * What was actually appending was a genuinely CHANGING value: the steps
   * ledger merged overlapping records with last-write-wins, and those records
   * disagreed about each bucket's calorie fields, so one day's calorie total
   * ping-ponged 643 <-> 671 and wrote two new lines every sync cycle. An
   * append-only store recording a value that really does flip-flop is correct
   * behaviour; the fix belonged upstream, in `health-live.ts`' merge, and is
   * there now (max-by-index, order-independent).
   *
   * So: do NOT add a second dedupe layer at a caller or in the file backend.
   * If the shard grows again, the value is changing and the question is why.
   */
  ingestSamples(samples: readonly HealthSample[]): number {
    const byShard = new Map<string, HealthSample[]>();
    for (const sample of samples) {
      if (!Number.isFinite(sample.startMs) || sample.spanMs <= 0) continue;
      const name = shardName(sample.startMs);
      const shard = this.loadShard(name);
      const key = sampleKey(sample);
      const existing = shard.get(key);
      if (existing && sameSample(existing, sample)) continue;
      shard.set(key, sample);
      const pending = byShard.get(name);
      if (pending) pending.push(sample);
      else byShard.set(name, [sample]);
    }
    let written = 0;
    for (const [name, list] of byShard) {
      const text = list.map((sample) => `${JSON.stringify(toLine(sample))}\n`).join("");
      this.backend.append(name, text);
      written += list.length;
    }
    if (written > 0) this.updateRollupsFor(samples);
    return written;
  }

  /**
   * Store sleep sessions. Durable before this returns.
   *
   * Deduped on the session's own start time, so a night re-delivered by a
   * later sync replaces rather than duplicates.
   */
  ingestSleep(sessions: readonly SleepSession[]): number {
    const held = this.loadSleep();
    const fresh: SleepSession[] = [];
    for (const session of sessions) {
      const index = held.findIndex(
        (candidate) =>
          candidate.startMs === session.startMs && candidate.timeResolved === session.timeResolved,
      );
      if (index >= 0) {
        if (JSON.stringify(held[index]) === JSON.stringify(session)) continue;
        held[index] = session;
      } else {
        held.push(session);
      }
      fresh.push(session);
    }
    if (fresh.length > 0) {
      this.backend.append(SLEEP_FILE, fresh.map((s) => `${JSON.stringify(s)}\n`).join(""));
    }
    return fresh.length;
  }

  // -------------------------------------------------------------------------
  // Reading

  /** Every stored sample overlapping [startMs, endMs). Exact - reads shards. */
  samplesInRange(startMs: number, endMs: number): HealthSample[] {
    const out: HealthSample[] = [];
    for (const name of this.shardNamesInRange(startMs, endMs)) {
      for (const sample of this.loadShard(name).values()) {
        if (sample.startMs >= startMs && sample.startMs < endMs) out.push(sample);
      }
    }
    out.sort((a, b) => a.startMs - b.startMs);
    return out;
  }

  /** Sleep sessions, newest first. */
  sleepSessions(): SleepSession[] {
    return this.loadSleep().slice().sort((a, b) => b.startMs - a.startMs);
  }

  /**
   * Daily rollups over a range, served from the derived cache.
   *
   * This is the path a month- or quarter-long chart takes, and it deliberately
   * never opens a sample shard. A day with no entry comes back absent, and the
   * caller renders a gap.
   */
  dailyRollups(metric: SampleMetric, startMs: number, endMs: number): Map<number, Rollup> {
    const file = this.loadRollups();
    const out = new Map<number, Rollup>();
    let cursor = startOfLocalDay(startMs);
    let guard = 0;
    while (cursor < endMs && guard < 2000) {
      guard += 1;
      const entry = file.days[dayKey(cursor)]?.[metric];
      if (entry) out.set(cursor, entry);
      const next = new Date(cursor);
      next.setDate(next.getDate() + 1);
      cursor = next.getTime();
    }
    return out;
  }

  /** Local midnight of the earliest day with any stored data, or null. */
  earliestDayMs(): number | null {
    const file = this.loadRollups();
    const keys = Object.keys(file.days).sort();
    if (keys.length === 0) return null;
    const parts = keys[0]!.split("-").map(Number);
    return new Date(parts[0]!, parts[1]! - 1, parts[2]!).getTime();
  }

  /** How many sample rows are held, across every loaded shard. */
  loadedSampleCount(): number {
    let total = 0;
    for (const shard of this.shards.values()) total += shard.size;
    return total;
  }

  // -------------------------------------------------------------------------
  // The derived cache

  /**
   * Rebuild `rollups.json` from the raw shards. Safe to call at any time; the
   * recovery path when the cache is missing, corrupt or from an older version.
   */
  rebuildRollups(): void {
    const days: RollupFile["days"] = {};
    const perDay = new Map<string, Map<SampleMetric, HealthSample[]>>();
    for (const name of this.backend.list()) {
      if (!name.startsWith(SAMPLE_PREFIX) || !name.endsWith(SAMPLE_SUFFIX)) continue;
      for (const sample of this.loadShard(name).values()) {
        const key = dayKey(sample.startMs);
        let byMetric = perDay.get(key);
        if (!byMetric) {
          byMetric = new Map();
          perDay.set(key, byMetric);
        }
        const list = byMetric.get(sample.metric);
        if (list) list.push(sample);
        else byMetric.set(sample.metric, [sample]);
      }
    }
    for (const [key, byMetric] of perDay) {
      const entry: Partial<Record<SampleMetric, Rollup>> = {};
      for (const metric of SAMPLE_METRICS) {
        const rolled = rollupOf(byMetric.get(metric) ?? []);
        if (rolled) entry[metric] = rolled;
      }
      days[key] = entry;
    }
    this.rollups = { version: ROLLUP_VERSION, days };
    this.persistRollups();
  }

  private updateRollupsFor(samples: readonly HealthSample[]): void {
    const file = this.loadRollups();
    const touched = new Set<string>();
    for (const sample of samples) touched.add(dayKey(sample.startMs));
    for (const key of touched) {
      const parts = key.split("-").map(Number);
      const dayStart = new Date(parts[0]!, parts[1]! - 1, parts[2]!).getTime();
      const dayEnd = new Date(parts[0]!, parts[1]! - 1, parts[2]! + 1).getTime();
      const inDay = this.samplesInRange(dayStart, dayEnd);
      const entry: Partial<Record<SampleMetric, Rollup>> = {};
      for (const metric of SAMPLE_METRICS) {
        const rolled = rollupOf(inDay.filter((sample) => sample.metric === metric));
        if (rolled) entry[metric] = rolled;
      }
      file.days[key] = entry;
    }
    this.persistRollups();
  }

  private persistRollups(): void {
    if (!this.rollups) return;
    this.backend.write(ROLLUP_FILE, JSON.stringify(this.rollups));
  }

  // -------------------------------------------------------------------------
  // Loading

  private shardNamesInRange(startMs: number, endMs: number): string[] {
    const names: string[] = [];
    const cursor = new Date(startOfLocalDay(startMs));
    cursor.setDate(1);
    let guard = 0;
    while (cursor.getTime() < endMs && guard < 240) {
      guard += 1;
      names.push(`${SAMPLE_PREFIX}${monthKey(cursor.getTime())}${SAMPLE_SUFFIX}`);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return names;
  }

  private loadShard(name: string): Map<string, HealthSample> {
    const held = this.shards.get(name);
    if (held) return held;
    const shard = new Map<string, HealthSample>();
    this.shards.set(name, shard);
    const text = this.backend.exists(name) ? this.backend.read(name) : null;
    if (!text) return shard;
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const sample = fromLine(line);
      // Later lines win: an append is how a re-synced bucket is corrected.
      if (sample) shard.set(sampleKey(sample), sample);
    }
    return shard;
  }

  private loadSleep(): SleepSession[] {
    if (this.sleep) return this.sleep;
    const sessions: SleepSession[] = [];
    const text = this.backend.exists(SLEEP_FILE) ? this.backend.read(SLEEP_FILE) : null;
    if (text) {
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        try {
          const parsed = JSON.parse(line) as SleepSession;
          if (typeof parsed?.startMs !== "number") continue;
          const index = sessions.findIndex((s) => s.startMs === parsed.startMs);
          if (index >= 0) sessions[index] = parsed;
          else sessions.push(parsed);
        } catch {
          // One unreadable line must not cost the rest of the file.
        }
      }
    }
    this.sleep = sessions;
    return sessions;
  }

  private loadRollups(): RollupFile {
    if (this.rollups) return this.rollups;
    const text = this.backend.exists(ROLLUP_FILE) ? this.backend.read(ROLLUP_FILE) : null;
    if (text) {
      try {
        const parsed = JSON.parse(text) as RollupFile;
        if (parsed?.version === ROLLUP_VERSION && parsed.days) {
          this.rollups = parsed;
          return parsed;
        }
      } catch {
        // Falls through to a rebuild - the cache is always reconstructible.
      }
    }
    this.rollups = { version: ROLLUP_VERSION, days: {} };
    this.rebuildRollups();
    return this.rollups;
  }
}

function sameSample(a: HealthSample, b: HealthSample): boolean {
  return a.min === b.min && a.max === b.max && a.avg === b.avg && a.total === b.total;
}

function toLine(sample: HealthSample): SampleLine {
  return {
    m: sample.metric,
    t: sample.startMs,
    s: sample.spanMs,
    n: sample.min,
    x: sample.max,
    a: sample.avg,
    u: sample.total,
  };
}

function fromLine(line: string): HealthSample | null {
  try {
    const parsed = JSON.parse(line) as SampleLine;
    if (typeof parsed?.t !== "number" || typeof parsed?.m !== "string") return null;
    return {
      metric: parsed.m,
      startMs: parsed.t,
      spanMs: parsed.s,
      min: parsed.n,
      max: parsed.x,
      avg: parsed.a,
      total: parsed.u,
    };
  } catch {
    return null;
  }
}
