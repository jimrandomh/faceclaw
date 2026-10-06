import { File, knownFolders } from "@nativescript/core";

/**
 * Persistence for the set of open apps, so a restart (usually installing a new
 * development build) reopens the same windows. Deliberately shallow: only
 * which apps were open and which was foreground, not within-app state.
 */

export type PersistedOpenApps = {
  /** App ids in sidebar (registration) order, launcher excluded. */
  open: string[];
  foreground: string | null;
};

const STATE_VERSION = 1;
const FILE_NAME = "open-apps.json";
// Coalesces bursts (restore, sidebar scrolling) into one write once they
// settle; short enough that a build-reinstall kill right after a change
// rarely loses it.
const WRITE_DELAY_MS = 1000;

function openAppsFilePath(): string {
  return `${knownFolders.documents().path}/${FILE_NAME}`;
}

/** The saved open-app state, or an empty state if missing or unreadable. */
export function loadPersistedOpenApps(): PersistedOpenApps {
  const empty: PersistedOpenApps = { open: [], foreground: null };
  try {
    const path = openAppsFilePath();
    if (!File.exists(path)) return empty;
    const parsed = JSON.parse(File.fromPath(path).readTextSync()) as {
      version?: number;
      open?: unknown;
      foreground?: unknown;
    };
    if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.open)) return empty;
    return {
      open: parsed.open.filter((appId): appId is string => typeof appId === "string"),
      foreground: typeof parsed.foreground === "string" ? parsed.foreground : null,
    };
  } catch (error) {
    console.warn("open-apps state read failed", error);
    return empty;
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: PersistedOpenApps | null = null;

/** Save the open-app state (debounced; the latest state wins). */
export function savePersistedOpenApps(state: PersistedOpenApps): void {
  pendingState = state;
  // Restarted on every change: scrolling through the switcher changes the
  // foreground app a few times a second, and each synchronous write costs
  // several milliseconds of main thread.
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const pending = pendingState;
    pendingState = null;
    if (!pending) return;
    try {
      File.fromPath(openAppsFilePath()).writeTextSync(
        JSON.stringify({ version: STATE_VERSION, ...pending }),
      );
    } catch (error) {
      console.warn("open-apps state write failed", error);
    }
  }, WRITE_DELAY_MS);
}
