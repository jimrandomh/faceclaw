/**
 * Launcher folder state: which apps are grouped into which named folder.
 * Stored as one JSON string (appId -> folder name) in the settings store, so
 * it persists and its changes broadcast to every isolate. An unset value means
 * the default grouping; any edit persists the whole map, so clearing out the
 * defaults sticks. Folders exist only while at least one app is assigned to
 * them — there is no separate create/delete step.
 */
import { getStringSetting, setStringSetting } from "../../native/settings-store";

const STORAGE_KEY = "launcher.folders";

/** The out-of-the-box grouping, applied only while the setting is unset. */
const DEFAULT_ASSIGNMENTS: Record<string, string> = {
  blocks: "Games",
  freecell: "Games",
  minesweeper: "Games",
  pinball: "Games",
  calculator: "Prototypes",
  microphones: "Prototypes",
  nightscout: "Prototypes",
  roam: "Prototypes",
};

export const FOLDER_NAME_MAX_LENGTH = 24;

/** appId -> folder name. Malformed stored JSON reads as "no folders". */
export function getFolderAssignments(): Record<string, string> {
  const raw = getStringSetting(STORAGE_KEY, "");
  if (!raw) return { ...DEFAULT_ASSIGNMENTS };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const assignments: Record<string, string> = {};
    for (const appId of Object.keys(parsed)) {
      const folder = parsed[appId];
      if (typeof folder === "string" && folder.trim()) {
        assignments[appId] = folder.trim();
      }
    }
    return assignments;
  } catch {
    return {};
  }
}

/** folder name -> appIds (assignment order), folder names sorted. */
export function getFolders(): Map<string, string[]> {
  const assignments = getFolderAssignments();
  const unsorted = new Map<string, string[]>();
  for (const appId of Object.keys(assignments)) {
    const folder = assignments[appId]!;
    const members = unsorted.get(folder);
    if (members) {
      members.push(appId);
    } else {
      unsorted.set(folder, [appId]);
    }
  }
  const folders = new Map<string, string[]>();
  for (const name of Array.from(unsorted.keys()).sort((a, b) => a.localeCompare(b))) {
    folders.set(name, unsorted.get(name)!);
  }
  return folders;
}

/** Assign an app to a folder, or (with null) return it to the top level. */
export function setAppFolder(appId: string, folder: string | null): void {
  const assignments = getFolderAssignments();
  if (folder) {
    assignments[appId] = folder;
  } else {
    delete assignments[appId];
  }
  setStringSetting(STORAGE_KEY, JSON.stringify(assignments));
}

/** Move every app out of a folder. Returns how many apps were moved. */
export function disbandFolder(folder: string): number {
  const assignments = getFolderAssignments();
  let moved = 0;
  for (const appId of Object.keys(assignments)) {
    if (assignments[appId] === folder) {
      delete assignments[appId];
      moved++;
    }
  }
  if (moved > 0) {
    setStringSetting(STORAGE_KEY, JSON.stringify(assignments));
  }
  return moved;
}

/**
 * An unused name for a ring-created folder ("New folder", "New folder 2", …).
 * Ring input has no text entry, so new folders start with a generated name;
 * the assistant's folder tools can regroup the apps under a better one.
 */
export function unusedNewFolderName(): string {
  const existing = new Set(Array.from(getFolders().keys()).map((name) => name.toLowerCase()));
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? "New folder" : `New folder ${i}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Match an existing folder name case-insensitively (so "games" reuses
 * "Games" instead of creating a near-duplicate), else the trimmed input.
 */
export function resolveFolderName(input: string): string {
  const trimmed = input.trim();
  for (const name of getFolders().keys()) {
    if (name.toLowerCase() === trimmed.toLowerCase()) return name;
  }
  return trimmed;
}

/** Raw stored value, for cheap change detection by the launcher window. */
export function getFolderStateFingerprint(): string {
  return getStringSetting(STORAGE_KEY, "");
}
