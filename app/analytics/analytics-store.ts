/**
 * Opt-in analytics, held on the phone between daily uploads to
 * stats.faceclaw.org. This is the platform-free core: storage, clock, the
 * data-collection setting and the network are passed in (analytics.ts wires
 * them up), so the tests can drive it directly.
 *
 * Data is recorded at a level, and only while the data-collection setting is
 * at that level or above:
 *  - "minimal": the app version and build, which devices are paired and in
 *    use, and connection-reliability counts;
 *  - "full": also API-key presence (never the keys) and settings chosen from
 *    fixed options.
 * Turning the setting down discards what was kept above the new level;
 * turning it off deletes everything, including the install id, and stops all
 * writes and uploads.
 *
 * Counters accumulate in pending.json (per UTC day). Once a day the pending
 * counters and a snapshot of the current state are sealed into an outbox
 * report, and every outbox report is posted; each stays until the server
 * accepts it, under a report id the server deduplicates on. The report
 * format is stats-server/PROTOCOL.md.
 */

export type AnalyticsLevel = "minimal" | "full";
export type DataCollectionLevel = "none" | AnalyticsLevel;
export type SnapshotValue = boolean | number | string;
export type Snapshot = Record<string, SnapshotValue>;

export interface AppInfo {
  version: string;
  platform: string;
  build: string;
}

/** Named text files in the analytics directory. */
export interface AnalyticsStorage {
  read(name: string): string | null;
  write(name: string, text: string): void;
  remove(name: string): void;
  list(): string[];
  /** Deletes the directory and everything in it. */
  removeAll(): void;
}

export interface AnalyticsDeps {
  storage: AnalyticsStorage;
  /** The data-collection setting, read fresh on every use. */
  level(): DataCollectionLevel;
  appInfo(): AppInfo;
  now(): number;
  randomId(): string;
  /** The current state to report at `level` (each level's keys, not cumulative). */
  snapshot(level: AnalyticsLevel): Snapshot;
  /** POSTs a report body; resolves to the HTTP status, rejects on network failure. */
  send(body: string): Promise<number>;
  log?(message: string): void;
}

/** UTC day (YYYY-MM-DD) → counter name → count. */
type Counters = Record<string, Record<string, number>>;
type ByLevel<T> = { minimal: T; full: T };

interface PendingFile {
  format: 1;
  /** The app version the counts were made under; a different one seals them. */
  version: string;
  counters: ByLevel<Counters>;
}

interface OutboxReport {
  format: 1;
  reportId: string;
  createdAt: string;
  app: AppInfo;
  counters: ByLevel<Counters>;
  snapshot: ByLevel<Snapshot>;
}

interface StateFile {
  format: 1;
  installId: string;
  lastSealAt: number;
  /** When to retry after a failed upload; 0 when none failed. */
  retryAt: number;
}

export const REPORT_SCHEMA_VERSION = 1;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const RETRY_MS = 60 * 60 * 1000;
/** Unsent reports kept while the server is unreachable; the oldest go first. */
export const MAX_OUTBOX_REPORTS = 30;
/** Distinct counter names per day and level, so a runaway name can't grow the file. */
export const MAX_NAMES_PER_DAY = 300;
const FLUSH_DELAY_MS = 15_000;

const PENDING_FILE = "pending.json";
const STATE_FILE = "state.json";
const OUTBOX_PREFIX = "outbox-";

/** Counter names and snapshot keys the server accepts (stats-server/src/report.ts). */
const COUNTER_NAME = /^[a-z0-9][a-z0-9_.:-]{0,119}$/;
const SNAPSHOT_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const MAX_SNAPSHOT_STRING = 200;

export class AnalyticsStore {
  private pending: PendingFile | null = null;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private uploading = false;
  /** Bumped by discardAll, so an upload in flight knows not to write its state back. */
  private generation = 0;

  constructor(private readonly deps: AnalyticsDeps) {}

  /** Whether data at `level` is being kept. */
  allows(level: AnalyticsLevel): boolean {
    const setting = this.deps.level();
    return setting === "full" || (setting === "minimal" && level === "minimal");
  }

  /** Adds `amount` to today's count of `name`. */
  count(level: AnalyticsLevel, name: string, amount = 1): void {
    if (!this.allows(level) || !(amount > 0)) return;
    if (!COUNTER_NAME.test(name)) {
      this.log(`analytics: dropping bad counter name ${name}`);
      return;
    }
    const day = this.dayCounters(level);
    if (day[name] === undefined && Object.keys(day).length >= MAX_NAMES_PER_DAY) return;
    day[name] = (day[name] ?? 0) + Math.round(amount);
    this.markDirty();
  }

  /** Records that `name` happened today (a count of 1, however often it happens). */
  flag(level: AnalyticsLevel, name: string): void {
    if (!this.allows(level)) return;
    if (!COUNTER_NAME.test(name)) {
      this.log(`analytics: dropping bad counter name ${name}`);
      return;
    }
    const day = this.dayCounters(level);
    if (day[name] !== undefined || Object.keys(day).length >= MAX_NAMES_PER_DAY) return;
    day[name] = 1;
    this.markDirty();
  }

  /**
   * Brings the files in line with the setting: off deletes everything,
   * minimal drops what was kept for full. Called at start and whenever the
   * setting changes.
   */
  applyLevel(): void {
    const setting = this.deps.level();
    if (setting === "none") {
      this.discardAll();
      return;
    }
    if (setting === "full") return;
    const pending = this.loadPending();
    if (Object.keys(pending.counters.full).length) {
      pending.counters.full = {};
      this.writePending(pending);
    }
    for (const name of this.outboxNames()) {
      const report = this.readJson(name) as OutboxReport | null;
      if (!report) continue;
      if (Object.keys(report.counters.full).length || Object.keys(report.snapshot.full).length) {
        report.counters.full = {};
        report.snapshot.full = {};
        this.deps.storage.write(name, JSON.stringify(report));
      }
    }
  }

  /** Writes pending counts now, if any changed. */
  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty || !this.pending) return;
    this.dirty = false;
    if (this.deps.level() === "none") {
      this.discardAll();
      return;
    }
    this.writePending(this.pending);
  }

  /**
   * The daily upload: once a day, seal the pending counts into a report and
   * post every unsent report; after a failure, retry hourly. Does nothing,
   * and makes no connection, while the setting is off.
   */
  async uploadIfDue(): Promise<void> {
    if (this.uploading) return;
    if (this.deps.level() === "none") {
      this.discardAll();
      return;
    }
    this.uploading = true;
    const generation = this.generation;
    try {
      const now = this.deps.now();
      const state = this.loadState();
      let sealed = false;
      // A clock set backwards shouldn't stall the schedule until it catches up.
      if (now - state.lastSealAt >= DAY_MS || now < state.lastSealAt) {
        this.seal();
        state.lastSealAt = now;
        this.writeState(state);
        sealed = true;
      }
      if (!sealed && !(state.retryAt > 0 && now >= state.retryAt)) return;

      for (const name of this.outboxNames()) {
        const report = this.readJson(name) as OutboxReport | null;
        if (!report) {
          this.deps.storage.remove(name);
          continue;
        }
        let status: number | null;
        try {
          status = await this.deps.send(this.reportBody(report, state.installId));
        } catch (error) {
          this.log(`analytics: upload failed: ${error}`);
          status = null;
        }
        // The setting may have been turned off (and maybe on again) while the
        // request was out; then everything this upload knew about is gone.
        if (this.deps.level() === "none") {
          this.discardAll();
          return;
        }
        if (this.generation !== generation) return;
        if (status !== null && status >= 200 && status < 300) {
          this.deps.storage.remove(name);
        } else if (status === 400 || status === 413) {
          // Rejected as malformed or too large: sending it again won't help.
          // (Anything else, like a 404 from a misconfigured server, is retried.)
          this.log(`analytics: server rejected report ${report.reportId} (HTTP ${status})`);
          this.deps.storage.remove(name);
        } else {
          state.retryAt = now + RETRY_MS;
          this.writeState(state);
          return;
        }
      }
      if (state.retryAt !== 0) {
        state.retryAt = 0;
        this.writeState(state);
      }
    } finally {
      this.uploading = false;
    }
  }

  /** Deletes everything kept, including the install id. */
  discardAll(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending = null;
    this.dirty = false;
    this.generation++;
    this.deps.storage.removeAll();
  }

  /** The JSON body posted for `report`, including only what the current setting allows. */
  reportBody(report: OutboxReport, installId: string): string {
    const level: AnalyticsLevel = this.deps.level() === "full" ? "full" : "minimal";
    const counters: Counters = {};
    for (const source of level === "full" ? [report.counters.minimal, report.counters.full] : [report.counters.minimal]) {
      for (const [day, counts] of Object.entries(source)) {
        const target = (counters[day] ??= {});
        for (const [name, count] of Object.entries(counts)) target[name] = (target[name] ?? 0) + count;
      }
    }
    return JSON.stringify({
      schema: REPORT_SCHEMA_VERSION,
      reportId: report.reportId,
      installId,
      level,
      createdAt: report.createdAt,
      app: report.app,
      counters,
      snapshot: level === "full" ? { ...report.snapshot.minimal, ...report.snapshot.full } : report.snapshot.minimal,
    });
  }

  private dayCounters(level: AnalyticsLevel): Record<string, number> {
    const day = new Date(this.deps.now()).toISOString().slice(0, 10);
    return (this.loadPending().counters[level][day] ??= {});
  }

  private markDirty(): void {
    this.dirty = true;
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DELAY_MS);
  }

  private loadPending(): PendingFile {
    if (this.pending) return this.pending;
    const version = this.deps.appInfo().version;
    const stored = this.readJson(PENDING_FILE) as PendingFile | null;
    if (stored && stored.format === 1 && stored.counters?.minimal && stored.counters?.full) {
      this.pending = stored;
      if (stored.version !== version && hasCounts(stored)) {
        // Counts from before an upgrade go out under the version they were made with.
        this.seal();
      }
    }
    return (this.pending ??= emptyPending(version));
  }

  /** Moves the pending counts, with a snapshot of the current state, into a new outbox report. */
  private seal(): void {
    const pending = this.loadPending();
    const app = { ...this.deps.appInfo(), version: pending.version };
    const report: OutboxReport = {
      format: 1,
      reportId: this.deps.randomId(),
      createdAt: new Date(this.deps.now()).toISOString(),
      app,
      counters: pending.counters,
      snapshot: {
        minimal: this.takeSnapshot("minimal"),
        full: this.allows("full") ? this.takeSnapshot("full") : {},
      },
    };
    this.deps.storage.write(`${OUTBOX_PREFIX}${report.createdAt.replace(/[^0-9]/g, "")}-${report.reportId}.json`, JSON.stringify(report));
    this.pending = emptyPending(this.deps.appInfo().version);
    this.dirty = false;
    this.writePending(this.pending);
    const outbox = this.outboxNames();
    for (const name of outbox.slice(0, Math.max(0, outbox.length - MAX_OUTBOX_REPORTS))) this.deps.storage.remove(name);
  }

  private takeSnapshot(level: AnalyticsLevel): Snapshot {
    const snapshot: Snapshot = {};
    let entries: [string, SnapshotValue][];
    try {
      entries = Object.entries(this.deps.snapshot(level));
    } catch (error) {
      this.log(`analytics: ${level} snapshot failed: ${error}`);
      return snapshot;
    }
    for (const [key, value] of entries) {
      const ok =
        SNAPSHOT_KEY.test(key) &&
        (typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value)) ||
          (typeof value === "string" && value.length <= MAX_SNAPSHOT_STRING));
      if (ok) snapshot[key] = value;
      else this.log(`analytics: dropping bad snapshot entry ${key}`);
    }
    return snapshot;
  }

  /** Outbox file names, oldest first (the names start with the seal time). */
  private outboxNames(): string[] {
    return this.deps.storage
      .list()
      .filter((name) => name.startsWith(OUTBOX_PREFIX))
      .sort();
  }

  private loadState(): StateFile {
    const stored = this.readJson(STATE_FILE) as StateFile | null;
    if (stored && stored.format === 1 && typeof stored.installId === "string") return stored;
    const state: StateFile = { format: 1, installId: this.deps.randomId(), lastSealAt: 0, retryAt: 0 };
    this.writeState(state);
    return state;
  }

  private writeState(state: StateFile): void {
    this.deps.storage.write(STATE_FILE, JSON.stringify(state));
  }

  private writePending(pending: PendingFile): void {
    this.deps.storage.write(PENDING_FILE, JSON.stringify(pending));
  }

  private readJson(name: string): unknown {
    const text = this.deps.storage.read(name);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      this.log(`analytics: discarding unreadable ${name}`);
      this.deps.storage.remove(name);
      return null;
    }
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}

function emptyPending(version: string): PendingFile {
  return { format: 1, version, counters: { minimal: {}, full: {} } };
}

function hasCounts(pending: PendingFile): boolean {
  return Object.keys(pending.counters.minimal).length > 0 || Object.keys(pending.counters.full).length > 0;
}
