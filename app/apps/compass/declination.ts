/**
 * Local magnetic declination for the compass, so the app can show true north.
 *
 * Declination only varies over tens of kilometres, so the location it needs is
 * whatever the phone can cheaply produce: the same one-shot coarse lookup the
 * Weather app uses, refreshed no more than daily. The last fix is persisted so
 * a fresh start has a usable declination before location comes back, and the
 * model is re-evaluated at the current time when it does.
 */
import { hasLocationPermission } from "../../g2/android-permissions";
import { magneticDeclinationDegrees } from "../../native/geomagnetic";
import { getCurrentLocation } from "../../native/location";
import { getStringSetting, setStringSetting } from "../../native/settings-store";

const LATITUDE_KEY = "compass.declination.latitude";
const LONGITUDE_KEY = "compass.declination.longitude";
const LOCATED_AT_KEY = "compass.declination.locatedAtMs";

/** A stored fix older than this is refreshed when the compass next runs. */
const FIX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Back-off between failed location attempts, so a denied or dark phone isn't polled. */
const RETRY_INTERVAL_MS = 10 * 60 * 1000;

export type DeclinationAvailability = "available" | "no-permission" | "no-fix";

type StoredFix = { latitude: number; longitude: number; locatedAtMs: number };

let declination: number | null = null;
let fix: StoredFix | null = null;
let loaded = false;
let refreshing = false;
let lastAttemptMs = 0;
const listeners = new Set<() => void>();

function loadStoredFix(): void {
  if (loaded) return;
  loaded = true;
  const latitude = parseFloat(getStringSetting(LATITUDE_KEY, ""));
  const longitude = parseFloat(getStringSetting(LONGITUDE_KEY, ""));
  const locatedAtMs = parseInt(getStringSetting(LOCATED_AT_KEY, ""), 10);
  if (Number.isFinite(latitude) && Number.isFinite(longitude) && Number.isFinite(locatedAtMs)) {
    fix = { latitude, longitude, locatedAtMs };
    declination = magneticDeclinationDegrees(latitude, longitude);
  }
}

/** Declination in degrees (east positive), or null when no location is known. */
export function getDeclinationDegrees(): number | null {
  loadStoredFix();
  return declination;
}

/** Why declination is or isn't available, for the compass status line. */
export function getDeclinationAvailability(): DeclinationAvailability {
  if (getDeclinationDegrees() !== null) return "available";
  return hasLocationPermission() ? "no-fix" : "no-permission";
}

export function onDeclinationChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fetch a location and recompute declination if the stored fix is stale or
 * missing. Safe to call on every compass start; it is a no-op while a lookup
 * is in flight, while the fix is fresh, or shortly after a failed attempt.
 * Never prompts for permission: callers that want to ask do that themselves.
 */
export function refreshDeclination(): void {
  loadStoredFix();
  if (refreshing || !hasLocationPermission()) return;
  const now = Date.now();
  if (fix !== null && now - fix.locatedAtMs < FIX_MAX_AGE_MS) return;
  if (now - lastAttemptMs < RETRY_INTERVAL_MS) return;
  lastAttemptMs = now;
  refreshing = true;
  getCurrentLocation()
    .then((location) => {
      const value = magneticDeclinationDegrees(location.latitude, location.longitude);
      if (value === null) return;
      fix = { latitude: location.latitude, longitude: location.longitude, locatedAtMs: now };
      declination = value;
      setStringSetting(LATITUDE_KEY, String(location.latitude));
      setStringSetting(LONGITUDE_KEY, String(location.longitude));
      setStringSetting(LOCATED_AT_KEY, String(now));
      for (const listener of listeners) listener();
    })
    .catch((error) => {
      console.warn(`Compass declination location lookup failed: ${error}`);
    })
    .finally(() => {
      refreshing = false;
    });
}
