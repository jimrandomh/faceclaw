/**
 * Saved and recent destinations for the Navigate app: Home and Work (plain
 * address settings, also editable in the Settings app), custom named
 * destinations, and a recency list of resolved places. Pure settings-store
 * accessors, usable from the worker and the main thread alike.
 */
import {
  navigateHomeAddressSetting,
  navigateRecentDestinationsSetting,
  navigateRememberRecentSetting,
  navigateSavedDestinationsSetting,
  navigateWorkAddressSetting,
} from "../../ui/dashboard-settings";

export const HOME_DESTINATION_ID = "home";
export const WORK_DESTINATION_ID = "work";

/** A named place the user set up; the address is resolved when navigating. */
export type SavedDestination = {
  id: string;
  name: string;
  address: string;
  /** Home and Work are fixed slots (renaming/removal disabled); others are custom. */
  builtin: boolean;
};

/** A place the user actually navigated to, already geocoded. */
export type RecentDestination = {
  name: string;
  place: string;
  longitude: number;
  latitude: number;
  atMs: number;
};

const MAX_RECENT = 8;
const MAX_CUSTOM = 20;

/** Every saved destination in display order: Home, Work (when set), then custom ones. */
export function loadSavedDestinations(): SavedDestination[] {
  const out: SavedDestination[] = [];
  const home = navigateHomeAddressSetting.get();
  if (home) out.push({ id: HOME_DESTINATION_ID, name: "Home", address: home, builtin: true });
  const work = navigateWorkAddressSetting.get();
  if (work) out.push({ id: WORK_DESTINATION_ID, name: "Work", address: work, builtin: true });
  out.push(...loadCustomDestinations());
  return out;
}

export function loadCustomDestinations(): SavedDestination[] {
  const parsed = parseJsonArray(navigateSavedDestinationsSetting.get());
  const out: SavedDestination[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const address = typeof record.address === "string" ? record.address.trim() : "";
    if (!id || !name) continue;
    out.push({ id, name, address, builtin: false });
  }
  return out;
}

function saveCustomDestinations(destinations: SavedDestination[]): void {
  navigateSavedDestinationsSetting.set(
    JSON.stringify(destinations.slice(0, MAX_CUSTOM).map(({ id, name, address }) => ({ id, name, address }))),
  );
}

/** Add a custom destination; returns its id. */
export function addCustomDestination(name: string, address: string): string {
  const id = `d${Date.now().toString(36)}`;
  saveCustomDestinations([...loadCustomDestinations(), { id, name, address, builtin: false }]);
  return id;
}

export function updateCustomDestination(id: string, patch: { name?: string; address?: string }): void {
  saveCustomDestinations(
    loadCustomDestinations().map((destination) =>
      destination.id === id
        ? { ...destination, name: patch.name ?? destination.name, address: patch.address ?? destination.address }
        : destination,
    ),
  );
}

export function removeCustomDestination(id: string): void {
  saveCustomDestinations(loadCustomDestinations().filter((destination) => destination.id !== id));
}

/** Set a destination's address; Home/Work go to their own settings. */
export function setDestinationAddress(id: string, address: string): void {
  if (id === HOME_DESTINATION_ID) navigateHomeAddressSetting.set(address);
  else if (id === WORK_DESTINATION_ID) navigateWorkAddressSetting.set(address);
  else updateCustomDestination(id, { address });
}

/**
 * Find a saved destination by name ("home", "work", or a custom name),
 * case-insensitively, for voice/assistant queries such as "navigate home".
 */
export function findSavedDestinationByName(query: string): SavedDestination | null {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return null;
  return loadSavedDestinations().find((destination) => destination.name.toLowerCase() === wanted) ?? null;
}

export function loadRecentDestinations(): RecentDestination[] {
  if (!navigateRememberRecentSetting.get()) return [];
  const parsed = parseJsonArray(navigateRecentDestinationsSetting.get());
  const out: RecentDestination[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const longitude = Number(record.longitude);
    const latitude = Number(record.latitude);
    if (!name || !Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    out.push({
      name,
      place: typeof record.place === "string" ? record.place : "",
      longitude,
      latitude,
      atMs: Number(record.atMs) || 0,
    });
  }
  return out;
}

/** Record a navigated-to place at the head of the recent list (no-op when the setting is off). */
export function rememberRecentDestination(destination: Omit<RecentDestination, "atMs">): void {
  if (!navigateRememberRecentSetting.get()) return;
  const others = loadRecentDestinations().filter((recent) => !isSamePlace(recent, destination));
  const next = [{ ...destination, atMs: Date.now() }, ...others].slice(0, MAX_RECENT);
  navigateRecentDestinationsSetting.set(JSON.stringify(next));
}

export function removeRecentDestination(destination: RecentDestination): void {
  const remaining = loadRecentDestinations().filter((recent) => !isSamePlace(recent, destination));
  navigateRecentDestinationsSetting.set(JSON.stringify(remaining));
}

export function clearRecentDestinations(): void {
  navigateRecentDestinationsSetting.set("[]");
}

function isSamePlace(
  a: { name: string; place: string; longitude: number; latitude: number },
  b: { name: string; place: string; longitude: number; latitude: number },
): boolean {
  // Within ~10 m, or the same name at the same formatted place: a repeat
  // visit, not a new entry. (Two branches of one chain stay distinct.)
  return (
    (a.name === b.name && a.place === b.place) ||
    (Math.abs(a.longitude - b.longitude) < 0.0001 && Math.abs(a.latitude - b.latitude) < 0.0001)
  );
}

function parseJsonArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
