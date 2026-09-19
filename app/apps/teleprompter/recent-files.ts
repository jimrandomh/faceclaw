import { getStringSetting, setStringSetting } from "../../native/settings-store";

/**
 * The Teleprompter's recently opened scripts, most recent first, with the
 * word position the reader was at when it closed (so reopening resumes
 * there). Stored as a JSON array in the settings store.
 */
export type RecentScript = {
  path: string;
  name: string;
  /** Word index the reader was at when last closed; 0 = start. */
  position: number;
  openedMs: number;
};

const RECENTS_KEY = "teleprompter.recents";
const MAX_RECENTS = 12;

export function getRecentScripts(): RecentScript[] {
  try {
    const parsed: unknown = JSON.parse(getStringSetting(RECENTS_KEY, "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is RecentScript => !!entry && typeof entry === "object" && typeof entry.path === "string")
      .map((entry) => ({
        path: entry.path,
        name: typeof entry.name === "string" && entry.name ? entry.name : baseName(entry.path),
        position: typeof entry.position === "number" && entry.position >= 0 ? entry.position : 0,
        openedMs: typeof entry.openedMs === "number" ? entry.openedMs : 0,
      }));
  } catch {
    return [];
  }
}

function saveRecentScripts(recents: RecentScript[]): void {
  setStringSetting(RECENTS_KEY, JSON.stringify(recents.slice(0, MAX_RECENTS)));
}

/** Move (or add) a script to the top of the list, keeping its saved position. */
export function touchRecentScript(path: string, name: string): RecentScript {
  const recents = getRecentScripts();
  const existing = recents.find((entry) => entry.path === path);
  const entry: RecentScript = {
    path,
    name,
    position: existing?.position ?? 0,
    openedMs: Date.now(),
  };
  saveRecentScripts([entry, ...recents.filter((other) => other.path !== path)]);
  return entry;
}

export function saveRecentScriptPosition(path: string, position: number): void {
  const recents = getRecentScripts();
  const entry = recents.find((other) => other.path === path);
  if (!entry) return;
  entry.position = Math.max(0, position);
  saveRecentScripts(recents);
}

export function removeRecentScript(path: string): void {
  saveRecentScripts(getRecentScripts().filter((entry) => entry.path !== path));
}

export function clearRecentScripts(): void {
  saveRecentScripts([]);
}

export function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** The last directory segment of a file path, for a dim "where it lives" hint. */
export function parentDirName(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return "";
  return baseName(path.slice(0, slash));
}
