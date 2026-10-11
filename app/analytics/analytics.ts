/**
 * The app's analytics API. What is collected, when it's kept and when it's
 * sent is described in analytics-store.ts; the snapshot providers (devices,
 * API-key presence, settings) are in analytics-snapshots.ts.
 *
 * Record from the main thread only. The store is created by startAnalytics()
 * at boot, which app workers never run, so calls made in a worker are
 * dropped. Kotlin-side connection events go through ConnectionCounters
 * (drained here) instead.
 */
import { File, Folder, knownFolders, path as fsPath } from "@nativescript/core";
import { buildKind } from "../native/build-info";
import { drainConnectionCounters } from "../native/connection-counters";
import { onSettingsStoreChanged } from "../native/settings-store";
import { DATA_COLLECTION_KEY, dataCollectionSetting } from "../ui/dashboard-settings";
import { fetchTextWithUserAgent } from "../util/http";
import { FACECLAW_VERSION } from "../version";
import {
  AnalyticsStore,
  type AnalyticsLevel,
  type AnalyticsStorage,
  type Snapshot,
} from "./analytics-store";

export type { AnalyticsLevel, Snapshot } from "./analytics-store";

declare const global: any;

const REPORT_URL = "https://stats.faceclaw.org/v1/report";
const REQUEST_TIMEOUT_MS = 30_000;
/** How often to see whether the daily upload is due (it usually isn't). */
const UPLOAD_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** The first check, a little after boot or after analytics is turned on. */
const FIRST_UPLOAD_CHECK_DELAY_MS = 2 * 60 * 1000;
/** How often the Kotlin connection counts are moved into the store. */
const DRAIN_INTERVAL_MS = 5 * 60 * 1000;

let store: AnalyticsStore | null = null;
let firstCheckTimer: ReturnType<typeof setTimeout> | null = null;
const snapshotProviders: { level: AnalyticsLevel; provide: () => Snapshot }[] = [];

/**
 * Adds `amount` to today's count of `name`, if the data-collection setting
 * includes `level`. Names are lowercase, dot-separated (e.g. "g2.connect").
 */
export function countAnalyticsEvent(level: AnalyticsLevel, name: string, amount = 1): void {
  store?.count(level, name, amount);
}

/** Records that `name` happened today: a count of 1 however often it happens. */
export function flagAnalyticsEvent(level: AnalyticsLevel, name: string): void {
  store?.flag(level, name);
}

/**
 * Adds state to report with each daily upload, when the setting includes
 * `level`. Called when the report is sealed; keys must be namespaced like
 * "device.g2.paired", and values booleans, numbers or short strings.
 */
export function registerAnalyticsSnapshot(level: AnalyticsLevel, provide: () => Snapshot): void {
  snapshotProviders.push({ level, provide });
}

/** Starts the store, the daily upload schedule and the counter drain. Main thread, once, at boot. */
export function startAnalytics(): void {
  if (store) return;
  const analytics = new AnalyticsStore({
    storage: createStorage(),
    level: () => dataCollectionSetting.get(),
    appInfo: () => ({ version: FACECLAW_VERSION, platform: global.isIOS ? "ios" : "android", build: buildKind() }),
    now: () => Date.now(),
    randomId: randomUuid,
    snapshot: collectSnapshot,
    send: sendReport,
    log: (message) => console.log(message),
  });
  store = analytics;
  analytics.applyLevel();

  onSettingsStoreChanged((key) => {
    if (key !== DATA_COLLECTION_KEY) return;
    analytics.applyLevel();
    if (dataCollectionSetting.get() !== "none") scheduleFirstCheck(analytics);
  });
  setInterval(() => drainKotlinCounters(analytics), DRAIN_INTERVAL_MS);
  setInterval(() => void checkUpload(analytics), UPLOAD_CHECK_INTERVAL_MS);
  scheduleFirstCheck(analytics);
}

function scheduleFirstCheck(analytics: AnalyticsStore): void {
  if (firstCheckTimer !== null) clearTimeout(firstCheckTimer);
  firstCheckTimer = setTimeout(() => {
    firstCheckTimer = null;
    void checkUpload(analytics);
  }, FIRST_UPLOAD_CHECK_DELAY_MS);
}

async function checkUpload(analytics: AnalyticsStore): Promise<void> {
  drainKotlinCounters(analytics);
  try {
    await analytics.uploadIfDue();
  } catch (error) {
    console.warn(`analytics: upload check failed: ${error}`);
  }
}

function drainKotlinCounters(analytics: AnalyticsStore): void {
  let counts: Record<string, number>;
  try {
    counts = drainConnectionCounters();
  } catch (error) {
    console.warn(`analytics: could not read connection counters: ${error}`);
    return;
  }
  // Drained either way, so counts from while analytics was off don't pile up.
  for (const [name, count] of Object.entries(counts)) analytics.count("minimal", name, count);
  analytics.flush();
}

function collectSnapshot(level: AnalyticsLevel): Snapshot {
  const snapshot: Snapshot = {};
  for (const provider of snapshotProviders) {
    if (provider.level !== level) continue;
    try {
      Object.assign(snapshot, provider.provide());
    } catch (error) {
      console.warn(`analytics: snapshot provider failed: ${error}`);
    }
  }
  return snapshot;
}

async function sendReport(body: string): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("timed out")), REQUEST_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([
      fetchTextWithUserAgent(REPORT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
      timedOut,
    ]);
    return response.status;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Files in an `analytics` directory: the app's private files directory on
 * Android; on iOS, Library rather than Documents, which the Files app shows.
 */
function createStorage(): AnalyticsStorage {
  const base = global.isIOS ? knownFolders.ios.library().path : knownFolders.documents().path;
  const dir = fsPath.join(base, "analytics");
  const filePath = (name: string) => fsPath.join(dir, name);
  return {
    read: (name) => (File.exists(filePath(name)) ? File.fromPath(filePath(name)).readTextSync() : null),
    write: (name, text) => {
      Folder.fromPath(dir);
      File.fromPath(filePath(name)).writeTextSync(text);
    },
    remove: (name) => {
      if (File.exists(filePath(name))) File.fromPath(filePath(name)).removeSync();
    },
    list: () => (Folder.exists(dir) ? Folder.fromPath(dir).getEntitiesSync().map((entity) => entity.name) : []),
    removeAll: () => {
      if (Folder.exists(dir)) Folder.fromPath(dir).removeSync();
    },
  };
}

function randomUuid(): string {
  const bytes = new Uint8Array(16);
  const crypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
