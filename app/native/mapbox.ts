/**
 * Mapbox REST client for the Navigate app: Search Box forward geocoding
 * (spoken destination → coordinates), Directions (route + maneuvers), and
 * Static Images (the rendered map pane). Workers use this directly; the
 * public token lives in settings under "maps.mapboxApiKey".
 */
import { GrayImage } from "../graphics/image";
import { getStringSetting } from "./settings-store";
import { grayImageFromPacket } from "./image-files";
import { fetchWithUserAgent } from "../util/http";

declare const com: any;
declare const global: any;

export const MAPBOX_TOKEN_SETTING_KEY = "maps.mapboxApiKey";
const SEARCH_ROOT = "https://api.mapbox.com/search/searchbox/v1";
const DIRECTIONS_ROOT = "https://api.mapbox.com/directions/v5";
const STATIC_ROOT = "https://api.mapbox.com/styles/v1";
/** Classic dark style; readable after gray conversion. Swappable for a custom Studio style later. */
const MAP_STYLE = "mapbox/dark-v11";
/**
 * Render-time style override: a black background inserted beneath the road
 * stack so land, landuse, water, and building fills all come out black on the
 * lens (dark-v11's own fills are dark gray, which the lens shows as a lit
 * haze). Static Images allows one added layer per request; `before_layer`
 * must name a layer in the style, so candidates are tried in order and a
 * rejected one is skipped for the rest of the session, ending with the plain
 * style (the worker's levelling pass then does what it can client-side).
 */
const STYLE_OVERRIDE_LAYER = JSON.stringify({
  id: "faceclaw-blackout",
  type: "background",
  paint: { "background-color": "#000000" },
});
/** First road layer of dark-v11, then a layer common to every Streets-based style. */
const STYLE_OVERRIDE_BEFORE_LAYERS = ["tunnel-path-trail", "building"];
let styleOverrideIndex = 0;
const FETCH_TIMEOUT_MS = 15_000;

export type RouteProfile = "driving" | "walking" | "cycling";

export type GeocodeCandidate = {
  name: string;
  placeFormatted: string;
  longitude: number;
  latitude: number;
  /** Straight-line meters from the proximity point, when Mapbox reports it. */
  distanceMeters: number | null;
};

export type RouteStep = {
  distanceMeters: number;
  durationSec: number;
  /** Road name for this step ("" when unnamed). */
  name: string;
  /** Human-readable instruction for the maneuver that starts this step. */
  instruction: string;
  maneuverType: string;
  maneuverModifier: string;
  /** Roundabout exit number, when applicable. */
  exit: number | null;
  /** Maneuver point [lon, lat]. */
  location: [number, number];
};

export type Route = {
  distanceMeters: number;
  durationSec: number;
  /** Full route geometry as [lon, lat] pairs. */
  coordinates: Array<[number, number]>;
  steps: RouteStep[];
};

export function getMapboxToken(): string {
  return getStringSetting(MAPBOX_TOKEN_SETTING_KEY, "") ?? "";
}

export function isMapboxConfigured(): boolean {
  return getMapboxToken().length > 0;
}

/** Resolve a free-text destination near the given location. */
export async function geocodeForward(
  query: string,
  proximity: { longitude: number; latitude: number } | null,
  limit = 5,
): Promise<GeocodeCandidate[]> {
  const params: Record<string, string> = {
    q: query,
    access_token: requireToken(),
    limit: String(limit),
    language: "en",
  };
  if (proximity) {
    params.proximity = `${round6(proximity.longitude)},${round6(proximity.latitude)}`;
  }
  const body = await fetchJson(`${SEARCH_ROOT}/forward?${queryString(params)}`, "Mapbox search");
  const features = Array.isArray(body?.features) ? body.features : [];
  const candidates: GeocodeCandidate[] = [];
  for (const feature of features) {
    const properties = feature?.properties;
    const coordinates = properties?.coordinates;
    const longitude = toFinite(coordinates?.longitude);
    const latitude = toFinite(coordinates?.latitude);
    if (longitude === null || latitude === null) continue;
    candidates.push({
      name: String(properties?.name ?? "").trim() || "(unnamed)",
      placeFormatted: String(properties?.place_formatted ?? "").trim(),
      longitude,
      latitude,
      distanceMeters: toFinite(properties?.distance),
    });
  }
  return candidates;
}

/** Fetch a route with turn-by-turn steps. */
export async function fetchRoute(
  origin: { longitude: number; latitude: number },
  destination: { longitude: number; latitude: number },
  profile: RouteProfile,
): Promise<Route> {
  const coords =
    `${round6(origin.longitude)},${round6(origin.latitude)};` +
    `${round6(destination.longitude)},${round6(destination.latitude)}`;
  const params = queryString({
    access_token: requireToken(),
    steps: "true",
    geometries: "geojson",
    overview: "full",
    language: "en",
  });
  const body = await fetchJson(
    `${DIRECTIONS_ROOT}/mapbox/${profile}/${coords}?${params}`,
    "Mapbox directions",
  );
  if (body?.code && body.code !== "Ok") {
    throw new Error(`No route found (${body.code}).`);
  }
  const route = body?.routes?.[0];
  if (!route) throw new Error("Mapbox returned no routes.");

  const coordinates: Array<[number, number]> = [];
  for (const pair of route.geometry?.coordinates ?? []) {
    const lon = toFinite(pair?.[0]);
    const lat = toFinite(pair?.[1]);
    if (lon !== null && lat !== null) coordinates.push([lon, lat]);
  }
  if (coordinates.length < 2) throw new Error("Mapbox returned an empty route geometry.");

  const steps: RouteStep[] = [];
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      const maneuver = step?.maneuver ?? {};
      const lon = toFinite(maneuver.location?.[0]);
      const lat = toFinite(maneuver.location?.[1]);
      steps.push({
        distanceMeters: toFinite(step?.distance) ?? 0,
        durationSec: toFinite(step?.duration) ?? 0,
        name: String(step?.name ?? "").trim(),
        instruction: String(maneuver.instruction ?? "").trim(),
        maneuverType: String(maneuver.type ?? "").trim(),
        maneuverModifier: String(maneuver.modifier ?? "").trim(),
        exit: toFinite(maneuver.exit),
        location: [lon ?? coordinates[0]![0], lat ?? coordinates[0]![1]],
      });
    }
  }
  if (!steps.length) throw new Error("Mapbox returned a route without steps.");

  return {
    distanceMeters: toFinite(route.distance) ?? 0,
    durationSec: toFinite(route.duration) ?? 0,
    coordinates,
    steps,
  };
}

export type StaticMapCamera =
  | { kind: "center"; longitude: number; latitude: number; zoom: number; bearingDeg: number }
  /** Fit the overlay path (route overview). */
  | { kind: "auto" };

/**
 * Fetch a rendered map image and decode it to grayscale. routePath (when
 * given) is drawn as a bright route line; the URL has an 8 KB cap so pass a
 * clipped/simplified polyline, not a 200-mile route.
 */
export async function fetchStaticMapGray(options: {
  camera: StaticMapCamera;
  width: number;
  height: number;
  routePath?: Array<[number, number]>;
}): Promise<GrayImage> {
  const overlays: string[] = [];
  if (options.routePath && options.routePath.length >= 2) {
    // Wide light route line with slight transparency so the road grid
    // underneath still reads.
    overlays.push(`path-6+ffffff-0.85(${encodeURIComponent(encodePolyline(options.routePath))})`);
  }
  const overlay = overlays.length ? `${overlays.join(",")}/` : "";
  const camera =
    options.camera.kind === "auto"
      ? "auto"
      : `${round6(options.camera.longitude)},${round6(options.camera.latitude)},` +
        `${options.camera.zoom.toFixed(2)},${Math.round(normalizeBearing(options.camera.bearingDeg))}`;
  const size = `${Math.round(options.width)}x${Math.round(options.height)}`;
  let bytes: ArrayBuffer;
  for (;;) {
    const beforeLayer = STYLE_OVERRIDE_BEFORE_LAYERS[styleOverrideIndex];
    const params: Record<string, string> = {
      access_token: requireToken(),
      logo: "false",
      attribution: "false",
    };
    if (beforeLayer !== undefined) {
      params.addlayer = STYLE_OVERRIDE_LAYER;
      params.before_layer = beforeLayer;
    }
    const url = `${STATIC_ROOT}/${MAP_STYLE}/static/${overlay}${camera}/${size}?${queryString(params)}`;

    const response = await fetchWithTimeout(url, "Mapbox static map");
    if (response.ok) {
      bytes = await response.arrayBuffer();
      break;
    }
    if (beforeLayer !== undefined && isStyleOverrideRejection(response.status)) {
      console.warn(`Mapbox rejected the map style override (before_layer=${beforeLayer}, HTTP ${response.status}); falling back`);
      styleOverrideIndex++;
      continue;
    }
    throw new Error(`Mapbox static map failed (HTTP ${response.status}).`);
  }
  if (!global.isAndroid) throw new Error("Map decoding is only available on Android.");
  const image = grayImageFromPacket(
    com.faceclaw.app.ImageFileLoader.loadGrayFromBytes(bytes, Math.round(options.width), Math.round(options.height)),
  );
  if (!image) throw new Error("Failed to decode the Mapbox map image.");
  return image;
}

/** Encode [lon, lat] pairs as a precision-5 polyline (Static Images path overlay format). */
export function encodePolyline(coordinates: Array<[number, number]>): string {
  let output = "";
  let lastLat = 0;
  let lastLon = 0;
  for (const [lon, lat] of coordinates) {
    const latE5 = Math.round(lat * 1e5);
    const lonE5 = Math.round(lon * 1e5);
    output += encodePolylineValue(latE5 - lastLat) + encodePolylineValue(lonE5 - lastLon);
    lastLat = latE5;
    lastLon = lonE5;
  }
  return output;
}

function encodePolylineValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let output = "";
  while (v >= 0x20) {
    output += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  output += String.fromCharCode(v + 63);
  return output;
}

/**
 * Manual query-string builder: the NativeScript runtime's URLSearchParams
 * doesn't populate from an object initializer, silently yielding an empty
 * query (observed as Mapbox HTTP 401 "Missing or empty access_token").
 */
function queryString(params: Record<string, string>): string {
  return Object.keys(params)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key]!)}`)
    .join("&");
}

function requireToken(): string {
  const token = getMapboxToken();
  if (!token) {
    throw new Error("Set a Mapbox token in Settings > API Keys first.");
  }
  return token;
}

async function fetchJson(url: string, label: string): Promise<any> {
  const response = await fetchWithTimeout(url, label);
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = String(body?.message ?? "");
    } catch {
      // Non-JSON error body; the status code is enough.
    }
    throw new Error(`${label} failed (HTTP ${response.status}${detail ? `: ${detail}` : ""}).`);
  }
  return response.json();
}

async function fetchWithTimeout(url: string, label: string): Promise<Response> {
  const request = fetchWithUserAgent(url);
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out.`)), FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * A client error that plausibly blames the added layer (an unknown
 * before_layer, or a style without it), as opposed to token or quota trouble
 * that the plain request would hit just the same.
 */
function isStyleOverrideRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429;
}

function normalizeBearing(bearingDeg: number): number {
  return ((bearingDeg % 360) + 360) % 360;
}

function round6(value: number): string {
  return value.toFixed(6);
}

function toFinite(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}
