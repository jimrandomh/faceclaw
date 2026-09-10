/**
 * Update detection for installed EvenHub apps.
 *
 * Two situations need the user's attention: the store has a newer version
 * than the one installed, and the registry lists a package whose EHPK is no
 * longer on disk (a settings export imported after a reinstall carries the
 * registry but not the files).
 */
import { statPath } from "../../native/file-access";
import { evenHubApi, EvenHubAuthenticationError, type EvenHubStoreApp } from "./even-api";
import {
  getInstalledEvenHubApps,
  installedEvenHubPackagePath,
  type InstalledEvenHubApp,
} from "./installed-apps";

export type EvenHubAppUpdate = {
  installed: InstalledEvenHubApp;
  /** Storefront record, or null when the store no longer lists the package. */
  latest: EvenHubStoreApp | null;
  /** The registry entry has no package file behind it. */
  packageMissing: boolean;
  /** The store's version is newer than the installed one. */
  updateAvailable: boolean;
  /** Why the store lookup failed, when it did. */
  error?: string;
};

/** Whether an installed package's EHPK is actually present on disk. */
export function isInstalledPackagePresent(packageId: string): boolean {
  const entry = statPath(installedEvenHubPackagePath(packageId));
  return entry !== null && !entry.isDirectory && entry.sizeBytes > 0;
}

/**
 * Whether `candidate` is a newer version than `current`. Dotted numeric
 * components compare numerically; non-numeric versions (or ones that agree
 * numerically but differ textually, e.g. "1.0.0-beta" vs "1.0.0") are not
 * treated as newer, so a stray tag never nags forever.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = versionComponents(candidate);
  const b = versionComponents(current);
  if (a.length === 0 || b.length === 0) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

function versionComponents(version: string): number[] {
  const match = version.trim().match(/^v?(\d+(?:\.\d+)*)/i);
  return match ? match[1]!.split(".").map(Number) : [];
}

/** Describe an installed app's standing against the store record it was fetched with. */
export function describeUpdate(installed: InstalledEvenHubApp, latest: EvenHubStoreApp | null): EvenHubAppUpdate {
  return {
    installed,
    latest,
    packageMissing: !isInstalledPackagePresent(installed.packageId),
    updateAvailable: latest !== null && isNewerVersion(latest.version, installed.version),
  };
}

/**
 * Look up every installed app in the store and return the ones needing
 * action (a newer version, or a missing package). Lookups run a few at a
 * time; `onProgress` reports how many have completed so far.
 */
export async function checkForEvenHubUpdates(
  onProgress?: (done: number, total: number) => void,
): Promise<EvenHubAppUpdate[]> {
  const installed = getInstalledEvenHubApps();
  const results: EvenHubAppUpdate[] = new Array(installed.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < installed.length) {
      const index = next++;
      const app = installed[index]!;
      try {
        results[index] = describeUpdate(app, await evenHubApi.getStoreAppDetail(app.packageId));
      } catch (error) {
        // A rejected session affects every lookup: let the caller re-login.
        if (error instanceof EvenHubAuthenticationError) throw error;
        results[index] = { ...describeUpdate(app, null), error: cleanError(error) };
      }
      done++;
      onProgress?.(done, installed.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, installed.length) }, worker));
  return results.filter((update) => update.updateAvailable || update.packageMissing);
}

function cleanError(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/[\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim();
}
