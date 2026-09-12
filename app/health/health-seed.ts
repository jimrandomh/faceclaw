/**
 * Seeding the store with sample data, and the marker that keeps a screenshot
 * of it honest.
 *
 * Without live ring hardware there is nothing in the store, and two empty
 * screens prove nothing. So the preview build seeds `health-fixtures.ts`'
 * generated data and drops `fixture-marker.json` beside it; both surfaces read
 * `isFixtureData()` and show a "Sample data" badge whenever it is there.
 *
 * The badge is the point. A health screen full of plausible numbers with no
 * provenance is the one artefact from this work that could be mistaken for a
 * real capture later, so the marker travels with the data rather than living
 * in someone's memory of how a screenshot was taken.
 *
 * Real ingest never writes the marker, so the first genuine sync leaves it
 * exactly as it was - which is why `clearFixtures()` exists and why the live
 * wiring should call it before its first write.
 */

import { File, knownFolders } from "@nativescript/core";

import { buildFixtures, FIXTURE_VERSION } from "./health-fixtures";
import { healthStore } from "./health-store-files";

const MARKER_FILE = "fixture-marker.json";

function markerPath(): string {
  return `${knownFolders.documents().getFolder("health").path}/${MARKER_FILE}`;
}

type Marker = { version: number; seededAtMs: number; days: number };

function readMarker(): Marker | null {
  try {
    if (!File.exists(markerPath())) return null;
    const parsed = JSON.parse(File.fromPath(markerPath()).readTextSync()) as Marker;
    return typeof parsed?.version === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** True when the store currently holds generated sample data. */
export function isFixtureData(): boolean {
  return readMarker() !== null;
}

/** Written by `health-live.ts` the first time real ring data lands. */
const LIVE_FILE = "live-marker.json";

function livePath(): string {
  return `${knownFolders.documents().getFolder("health").path}/${LIVE_FILE}`;
}

/** True once this install has ever stored a record decoded off the ring. */
export function hasLiveData(): boolean {
  try {
    return File.exists(livePath());
  } catch {
    return false;
  }
}

/** Record that real data has been stored. Called by the live ingest path. */
export function markLiveData(): void {
  try {
    File.fromPath(livePath()).writeTextSync(JSON.stringify({ firstAtMs: Date.now() }));
  } catch (error) {
    console.warn("health live marker write failed", error);
  }
}

/**
 * Delete every stored sample, session and rollup, and the fixture badge with
 * them. Called before the first genuine ingest.
 *
 * `clearFixtureMarker()` is not enough on its own and never was: dropping the
 * badge while leaving 45 days of generated samples in the store produces
 * exactly the artefact this file's header warns about — plausible numbers with
 * no provenance, now unlabelled. Real data gets a clean store or none.
 */
export function purgeFixtureData(): void {
  if (!isFixtureData()) return;
  try {
    const folder = knownFolders.documents().getFolder("health");
    for (const entity of folder.getEntitiesSync()) {
      const name = entity.name;
      const isStoreFile =
        (name.startsWith("samples-") && name.endsWith(".jsonl")) ||
        name === "sleep.jsonl" ||
        name === "rollups.json";
      if (isStoreFile) File.fromPath(entity.path).removeSync();
    }
  } catch (error) {
    console.warn("health fixture purge failed", error);
  }
  clearFixtureMarker();
}

/**
 * Seed sample data if none is present, or if the generator has changed since
 * the last seed. A no-op once seeded, so it is safe to call on every launch.
 *
 * Refuses outright once real ring data has ever been stored — otherwise a
 * version bump to the generator would inject fixtures back on top of a real
 * history, which is worse than an empty screen.
 */
export function seedFixturesIfNeeded(days = 45): boolean {
  if (hasLiveData()) return false;
  const marker = readMarker();
  if (marker && marker.version === FIXTURE_VERSION && marker.days >= days) return false;
  return seedFixtures(days);
}

export function seedFixtures(days = 45): boolean {
  try {
    const store = healthStore();
    const { samples, sleep } = buildFixtures({ days, nowMs: Date.now() });
    store.ingestSamples(samples);
    store.ingestSleep(sleep);
    const marker: Marker = { version: FIXTURE_VERSION, seededAtMs: Date.now(), days };
    File.fromPath(markerPath()).writeTextSync(JSON.stringify(marker));
    return true;
  } catch (error) {
    console.warn("health fixture seed failed", error);
    return false;
  }
}

/** Drop the marker. Call before the first real ingest. */
export function clearFixtureMarker(): void {
  try {
    if (File.exists(markerPath())) File.fromPath(markerPath()).removeSync();
  } catch (error) {
    console.warn("health fixture marker clear failed", error);
  }
}
