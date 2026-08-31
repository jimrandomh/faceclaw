/**
 * Navigate app worker: voice/tool-set destination, Mapbox routing, and
 * turn-by-turn guidance with a live map pane.
 *
 * The BLE frame budget shapes the layout (see notes/navigate-app-design.md):
 * the map bitmap (left pane) refreshes on a slow staleness policy, while the
 * guidance text (right pane) updates per GPS fix and ships as small deltas.
 */
import "@nativescript/core/globals";
import { GrayImage } from "../../graphics/image";
import { flattenPlanesWithDraws, planesFingerprint, singlePlane, type Plane } from "../../graphics/plane";
import { prepareFrameDraws } from "../../graphics/glyph-wire";
import { getFont } from "../../graphics/bdffont";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import * as frameTimings from "../../native/frame-timings";
import { getActiveDisplay } from "../../native/active-display";
import { defaultWindowMenuItems, WindowMenu } from "../../ui/window-menu";
import type { WorkerAppMessage, WorkerAppReply } from "../../ui/shell/worker-window";
import type { ToolSpec, ToolResult } from "../../assistant/tool-registry";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, type InputEvent } from "../../ui/gestures";
import { LocationTracker, type TrackedLocation } from "../../native/location-tracker";
import {
  fetchRoute,
  fetchStaticMapGray,
  geocodeForward,
  isMapboxConfigured,
  type GeocodeCandidate,
  type Route,
  type RouteProfile,
  type StaticMapCamera,
} from "../../native/mapbox";
import { bearingDegrees, haversineMeters, RouteFollower, type RouteProgress } from "./route-follower";
import { drawManeuverGlyph } from "./maneuver-icons";

declare const global: any;
declare const com: any;

const MAP_SIZE = 260;
const PANEL_X = MAP_SIZE + 10;
/** Map refetch policy knobs (design doc: never per-fix, only when stale). */
const BEARING_BUCKET_DEG = 15;
const MOVE_REFRESH_FRACTION = 0.15;
const IDLE_REFRESH_MS = 5_000;
const IDLE_REFRESH_MIN_MOVE_M = 10;
const MAP_RETRY_BACKOFF_MS = 5_000;
const REROUTE_MIN_INTERVAL_MS = 20_000;
const FIRST_FIX_TIMEOUT_MS = 10_000;
const LOCATION_INTERVAL_MS = 1_000;
/** Above this speed a GPS bearing is trustworthy for heading-up. */
const BEARING_MIN_SPEED_MPS = 2.5;

const largeFont = getFont("terminus32");
const mediumFont = getFont("terminus24");
const smallFont = getDefaultSmallFont();

type NavPhase = "idle" | "acquiring" | "routing" | "navigating" | "arrived";
type MapMode = "follow" | "overview";

type NavWindow = {
  windowId: string;
  surfaceId: string;
  viewportWidth: number;
  viewportHeight: number;
  foreground: boolean;
  focused: boolean;
  menu: WindowMenu | null;
  lastSubmittedFingerprint: string;
};

const NAVIGATE_TOOLS: ToolSpec[] = [
  {
    name: "start_route",
    description:
      "Start turn-by-turn navigation to a destination. Give the destination as free text (a place name, business, or address); it is resolved near the user's current location. Returns the resolved destination, distance, and estimated time. If the wrong place was picked, call again with a more specific query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Destination to search for, e.g. 'Golden Gate Park' or '410 Townsend St'." },
        profile: {
          type: "string",
          enum: ["driving", "walking", "cycling"],
          description: "Travel mode (default driving).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    availability: "open",
    // Under the 15 s host backstop; first GPS fix + two API calls can be slow.
    timeoutMs: 14_000,
  },
  {
    name: "stop_route",
    description: "Stop the current navigation session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    availability: "open",
  },
  {
    name: "route_status",
    description:
      "Get the current navigation status: next maneuver, distance to it, remaining distance/time, and ETA.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    availability: "open",
  },
];

// Singleton window; navigation state outlives foreground/background flips.
let window: NavWindow | null = null;
let screenOn = true;

let phase: NavPhase = "idle";
let statusMessage = "";
let destinationName = "";
let destinationPlace = "";
let destination: { longitude: number; latitude: number } | null = null;
let profile: RouteProfile = "driving";
let follower: RouteFollower | null = null;
let progress: RouteProgress | null = null;
let lastFix: TrackedLocation | null = null;
let lastBearingDeg = 0;
let lastRerouteAtMs = 0;
let rerouteInFlight = false;
/** Bumped on every new route/mode so stale map fetches can be discarded. */
let routeGeneration = 0;

let mapMode: MapMode = "follow";
let zoomOffset = 0;
let mapImage: GrayImage | null = null;
let mapFetchedKey = "";
let mapInFlight = false;
let mapLastFetchAtMs = 0;
let mapLastFetchCenter: [number, number] | null = null;
let mapNextRetryAtMs = 0;
let mapLastError = "";

let tickTimer: ReturnType<typeof setInterval> | null = null;
let firstFixWaiters: Array<(fix: TrackedLocation) => void> = [];

const tracker = new LocationTracker({
  onLocation: (fix) => handleFix(fix),
  onError: (message) => {
    statusMessage = message;
    if (phase === "acquiring") phase = "idle";
    render();
  },
});

function post(message: WorkerAppReply): void {
  global.postMessage(message);
}

// The host queues messages until this arrives: posts to a worker whose bundle
// is still evaluating can be silently dropped (see WorkerAppHost). Top-level
// evaluation is synchronous, so the handler below is installed before any
// queued message can be delivered.
post({ type: "worker-ready" });

global.onmessage = (event: { data: WorkerAppMessage }) => {
  const message = event.data;
  switch (message.type) {
    case "open-window":
      window = {
        windowId: message.windowId,
        surfaceId: message.surfaceId,
        viewportWidth: message.viewport.width,
        viewportHeight: message.viewport.height,
        foreground: false,
        focused: false,
        menu: null,
        lastSubmittedFingerprint: "",
      };
      post({ type: "set-tools", windowId: message.windowId, tools: NAVIGATE_TOOLS });
      break;
    case "close-window":
      stopNavigation("");
      window = null;
      break;
    case "input":
      if (!window || window.windowId !== message.windowId) {
        frameTimings.finishFrame(message.frameId, "discarded: unknown navigate window");
        break;
      }
      window.focused = message.focused;
      // Marks the main-thread -> worker hop, which is otherwise an
      // unexplained gap inside the shell's handle-input span.
      frameTimings.logFrame(message.frameId, `input received in ${message.windowId} worker`);
      handleInput(window, message.event as InputEvent, message.frameId);
      break;
    case "text-input":
      // Voice input / typed text sets a destination directly.
      if (message.text.trim()) {
        void startNavigation(message.text.trim(), profile).catch(() => {});
      }
      break;
    case "render":
      if (!window) break;
      window.focused = message.focused;
      render();
      break;
    case "foreground":
      if (!window) break;
      window.foreground = message.foreground;
      window.focused = message.focused;
      if (window.foreground) {
        maybeRefreshMap();
        render();
      }
      break;
    case "screen":
      screenOn = message.on;
      if (screenOn && window?.foreground) {
        maybeRefreshMap();
        render();
      }
      break;
    case "tool-call": {
      const callId = message.callId;
      Promise.resolve(handleNavigateTool(message.name, message.args))
        .then((result) => post({ type: "tool-result", callId, result }))
        .catch((error) =>
          post({
            type: "tool-result",
            callId,
            result: { ok: false, error: String((error as Error)?.message ?? error) },
          }),
        );
      break;
    }
  }
};

// ---------------------------------------------------------------------------
// Navigation state machine

async function startNavigation(query: string, requestedProfile: RouteProfile): Promise<string> {
  if (!isMapboxConfigured()) {
    statusMessage = "Set a Mapbox token in Settings > API Keys.";
    phase = "idle";
    render();
    throw new Error(statusMessage);
  }
  const hadActiveRoute = phase === "navigating" && follower !== null;
  const previous = {
    destination,
    destinationName,
    destinationPlace,
    profile,
  };
  try {
    profile = requestedProfile;
    phase = "acquiring";
    statusMessage = `Locating you for "${query}"...`;
    render();
    ensureTracking();
    const fix = await waitForFix();

    phase = "routing";
    statusMessage = `Finding ${query}...`;
    render();
    const candidates = await geocodeForward(query, fix, 5);
    if (!candidates.length) {
      throw new Error(`No places found matching "${query}".`);
    }
    const picked = candidates[0]!;
    destination = { longitude: picked.longitude, latitude: picked.latitude };
    destinationName = picked.name;
    destinationPlace = picked.placeFormatted;

    statusMessage = `Routing to ${picked.name}...`;
    render();
    const route = await fetchRoute(fix, destination, profile);
    adoptRoute(route);
    if (window) post({ type: "focus-window", windowId: window.windowId });
    return startSummary(picked, candidates, route);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    statusMessage = message;
    // A failed new destination shouldn't kill guidance that was already
    // running; fall back to the ongoing route (and its destination, which
    // the geocode step may have partially overwritten).
    if (hadActiveRoute) {
      phase = "navigating";
      destination = previous.destination;
      destinationName = previous.destinationName;
      destinationPlace = previous.destinationPlace;
      profile = previous.profile;
    } else {
      phase = "idle";
    }
    stopTrackingIfIdle();
    render();
    throw error;
  }
}

function adoptRoute(route: Route): void {
  follower = new RouteFollower(route);
  progress = null;
  phase = "navigating";
  mapMode = "follow";
  zoomOffset = 0;
  statusMessage = "";
  routeGeneration++;
  resetMapState();
  ensureTracking();
  ensureTickTimer();
  if (lastFix) handleFix(lastFix);
  maybeRefreshMap();
  render();
}

function stopNavigation(finalStatus: string): void {
  phase = "idle";
  statusMessage = finalStatus;
  follower = null;
  progress = null;
  destination = null;
  destinationName = "";
  destinationPlace = "";
  routeGeneration++;
  resetMapState();
  stopTrackingIfIdle();
  ensureTickTimer();
}

function handleFix(fix: TrackedLocation): void {
  lastFix = fix;
  if (fix.bearingDeg !== null && (fix.speedMps ?? 0) >= BEARING_MIN_SPEED_MPS) {
    lastBearingDeg = fix.bearingDeg;
  }
  for (const waiter of firstFixWaiters.splice(0)) waiter(fix);

  if (phase !== "navigating" || !follower) return;
  progress = follower.update(fix.longitude, fix.latitude);

  if (progress.arrived) {
    phase = "arrived";
    statusMessage = "";
    stopTrackingIfIdle();
    ensureTickTimer();
    render();
    return;
  }
  if (progress.offRoute) {
    void maybeReroute(fix);
  }
  maybeRefreshMap();
  render();
}

async function maybeReroute(fix: TrackedLocation): Promise<void> {
  if (rerouteInFlight || !destination) return;
  if (Date.now() - lastRerouteAtMs < REROUTE_MIN_INTERVAL_MS) return;
  rerouteInFlight = true;
  lastRerouteAtMs = Date.now();
  statusMessage = "Rerouting...";
  render();
  try {
    const route = await fetchRoute(fix, destination, profile);
    if (phase === "navigating") adoptRoute(route);
  } catch (error) {
    statusMessage = `Reroute failed: ${String((error as Error)?.message ?? error)}`;
    render();
  } finally {
    rerouteInFlight = false;
  }
}

function ensureTracking(): void {
  if (!tracker.isRunning()) tracker.start(LOCATION_INTERVAL_MS);
}

function stopTrackingIfIdle(): void {
  if (phase === "idle" || phase === "arrived") {
    tracker.stop();
    firstFixWaiters = [];
  }
}

function waitForFix(): Promise<TrackedLocation> {
  if (lastFix && Date.now() - lastFix.timestampMs < 60_000) {
    return Promise.resolve(lastFix);
  }
  return new Promise<TrackedLocation>((resolve, reject) => {
    const timer = setTimeout(() => {
      firstFixWaiters = firstFixWaiters.filter((waiter) => waiter !== onFix);
      reject(new Error("Couldn't get a GPS fix yet; try again in a moment."));
    }, FIRST_FIX_TIMEOUT_MS);
    const onFix = (fix: TrackedLocation) => {
      clearTimeout(timer);
      resolve(fix);
    };
    firstFixWaiters.push(onFix);
  });
}

function ensureTickTimer(): void {
  const shouldRun = phase === "navigating";
  if (shouldRun && tickTimer === null) {
    tickTimer = setInterval(() => {
      maybeRefreshMap();
      render(); // ETA/minute updates; fingerprint dedup keeps the wire quiet.
    }, 2_000);
  } else if (!shouldRun && tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Map pane

function resetMapState(): void {
  mapImage = null;
  mapFetchedKey = "";
  mapInFlight = false;
  mapLastFetchAtMs = 0;
  mapLastFetchCenter = null;
  mapNextRetryAtMs = 0;
  mapLastError = "";
}

function currentPosition(): [number, number] | null {
  if (progress) return progress.snapped;
  if (lastFix) return [lastFix.longitude, lastFix.latitude];
  return null;
}

function currentBearing(): number {
  if (lastFix && lastFix.bearingDeg !== null && (lastFix.speedMps ?? 0) >= BEARING_MIN_SPEED_MPS) {
    return lastFix.bearingDeg;
  }
  if (lastBearingDeg) return lastBearingDeg;
  // Fall back to the direction the route heads from here.
  if (follower && progress) {
    const slice = follower.routeSliceAround(progress.alongMeters, 0, 120);
    if (slice.length >= 2) return bearingDegrees(slice[0]!, slice[slice.length - 1]!);
  }
  return 0;
}

function currentZoom(): number {
  let zoom: number;
  if (profile === "walking") {
    zoom = 16.5;
  } else if (progress && progress.metersToNextManeuver < 250) {
    zoom = 16.5;
  } else if (progress && progress.metersToNextManeuver < 1000) {
    zoom = 15.5;
  } else {
    zoom = 14.5;
  }
  return Math.max(11, Math.min(18, zoom + zoomOffset));
}

function metersPerPixel(zoom: number, latitude: number): number {
  return (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / Math.pow(2, zoom);
}

function desiredMapView(): { camera: StaticMapCamera; key: string; path: Array<[number, number]> } | null {
  if (mapMode === "overview" && follower) {
    return {
      camera: { kind: "auto" },
      key: `auto|${routeGeneration}`,
      path: simplifyPath(follower.route.coordinates, 100),
    };
  }
  const position = currentPosition();
  if (!position) return null;
  const zoom = currentZoom();
  const bearing = Math.round(currentBearing() / BEARING_BUCKET_DEG) * BEARING_BUCKET_DEG;
  const path =
    follower && progress
      ? simplifyPath(follower.routeSliceAround(progress.alongMeters, 250, 3000), 80)
      : [];
  return {
    camera: { kind: "center", longitude: position[0], latitude: position[1], zoom, bearingDeg: bearing },
    key: `c|${zoom.toFixed(2)}|${bearing}|${routeGeneration}`,
    path,
  };
}

/**
 * Refetch the map only when meaningfully stale: camera key changed (zoom /
 * bearing bucket / mode / route), moved a good fraction of the viewport, or
 * a few seconds passed while moving. Single-flight with failure backoff.
 */
function maybeRefreshMap(): void {
  if (!window || !window.foreground || !screenOn) return;
  if (mapInFlight || Date.now() < mapNextRetryAtMs) return;
  if (!isMapboxConfigured()) return;
  const view = desiredMapView();
  if (!view) return;

  let stale = mapImage === null || view.key !== mapFetchedKey;
  if (!stale && view.camera.kind === "center" && mapLastFetchCenter) {
    const moved = haversineMeters(mapLastFetchCenter, [view.camera.longitude, view.camera.latitude]);
    const viewportMeters = MAP_SIZE * metersPerPixel(view.camera.zoom, view.camera.latitude);
    if (moved > viewportMeters * MOVE_REFRESH_FRACTION) stale = true;
    else if (Date.now() - mapLastFetchAtMs > IDLE_REFRESH_MS && moved > IDLE_REFRESH_MIN_MOVE_M) stale = true;
  }
  if (!stale) return;

  mapInFlight = true;
  const generation = routeGeneration;
  fetchStaticMapGray({
    camera: view.camera,
    width: MAP_SIZE,
    height: MAP_SIZE,
    routePath: view.path.length >= 2 ? view.path : undefined,
  })
    .then((image) => {
      mapInFlight = false;
      if (generation !== routeGeneration) return; // Route/mode changed mid-fetch.
      boostContrast(image);
      mapImage = image;
      mapFetchedKey = view.key;
      mapLastFetchAtMs = Date.now();
      mapLastFetchCenter = view.camera.kind === "center" ? [view.camera.longitude, view.camera.latitude] : null;
      mapLastError = "";
      render();
    })
    .catch((error) => {
      mapInFlight = false;
      mapNextRetryAtMs = Date.now() + MAP_RETRY_BACKOFF_MS;
      mapLastError = String((error as Error)?.message ?? error);
      render();
    });
}

/** Keep every Nth point (ends always included) to bound the overlay URL size. */
function simplifyPath(path: Array<[number, number]>, maxPoints: number): Array<[number, number]> {
  if (path.length <= maxPoints) return path;
  const step = (path.length - 1) / (maxPoints - 1);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(path[Math.round(i * step)]!);
  }
  return out;
}

/** Stretch the dark-style render so roads survive 4bpp quantization. */
function boostContrast(image: GrayImage): void {
  for (let i = 0; i < image.pixels.length; i++) {
    const value = image.pixels[i]!;
    image.pixels[i] = Math.max(0, Math.min(255, Math.round((value - 12) * 1.7)));
  }
}

// ---------------------------------------------------------------------------
// Tools

async function handleNavigateTool(name: string, args: any): Promise<ToolResult> {
  switch (name) {
    case "start_route": {
      const query = String(args?.query ?? "").trim();
      if (!query) return { ok: false, error: "start_route requires a destination query" };
      const requested = String(args?.profile ?? "driving");
      const routeProfile: RouteProfile =
        requested === "walking" || requested === "cycling" ? requested : "driving";
      try {
        const summary = await startNavigation(query, routeProfile);
        return { ok: true, content: summary };
      } catch (error) {
        return { ok: false, error: String((error as Error)?.message ?? error) };
      }
    }
    case "stop_route":
      if (phase === "idle") return { ok: true, content: "Navigation was not active." };
      stopNavigation("Navigation stopped.");
      render();
      return { ok: true, content: "Navigation stopped." };
    case "route_status":
      return { ok: true, content: describeRouteStatus() };
    default:
      return { ok: false, error: `Unknown navigate tool: ${name}` };
  }
}

function startSummary(picked: GeocodeCandidate, candidates: GeocodeCandidate[], route: Route): string {
  const parts = [
    `Navigating to ${picked.name}${picked.placeFormatted ? ` (${picked.placeFormatted})` : ""}: ` +
      `${formatDistance(route.distanceMeters)}, about ${formatDurationLong(route.durationSec)}, ` +
      `arriving ${formatClock(Date.now() + route.durationSec * 1000)}.`,
  ];
  const alternates = candidates.slice(1, 3);
  if (alternates.length) {
    parts.push(
      `Other matches: ${alternates
        .map((c) => `${c.name}${c.placeFormatted ? ` (${c.placeFormatted})` : ""}`)
        .join("; ")}. Call start_route with a more specific query to pick one of these instead.`,
    );
  }
  return parts.join(" ");
}

function describeRouteStatus(): string {
  if (phase === "arrived") return `Arrived at ${destinationName}.`;
  if (phase !== "navigating" || !follower) return "Navigation is not active.";
  if (!progress) return `Navigating to ${destinationName}; waiting for a GPS fix.`;
  const step = follower.route.steps[progress.nextStepIndex]!;
  return (
    `Next: ${step.instruction || step.maneuverType} in ${formatDistance(progress.metersToNextManeuver)}. ` +
    `${formatDistance(progress.remainingMeters)} and ${formatDurationLong(progress.remainingSec)} remaining; ` +
    `ETA ${formatClock(Date.now() + progress.remainingSec * 1000)}.`
  );
}

// ---------------------------------------------------------------------------
// Input

function windowMenu(win: NavWindow): WindowMenu {
  if (!win.menu) {
    win.menu = new WindowMenu({
      size: { width: win.viewportWidth, height: win.viewportHeight },
      paintBase: () => paintContent(win),
      isFocused: () => win.focused,
    });
  }
  return win.menu;
}

function handleInput(win: NavWindow, event: InputEvent, frameId: number): void {
  if (win.menu?.isOpen()) {
    win.menu
      .handleInput(event)
      .catch((error) => console.error(`navigate menu input failed: ${error}`))
      .then(() => renderAndSubmit(win, frameId));
    return;
  }
  if (event.type === "long-press") {
    const items = [...defaultWindowMenuItems(win.windowId, post)];
    if (phase === "navigating" || phase === "arrived") {
      items.unshift({
        label: "Stop navigation",
        onSelect: (ctx: any) => {
          ctx.stack.pop();
          stopNavigation("Navigation stopped.");
          render();
        },
      });
    }
    windowMenu(win).open(items);
    renderAndSubmit(win, frameId);
    return;
  }
  if (event.type === "double-click") {
    frameTimings.finishFrame(frameId, "discarded: navigate yielded focus");
    post({ type: "yield-focus", windowId: win.windowId });
    return;
  }
  if (event.type === "click") {
    if (phase === "navigating") {
      mapMode = mapMode === "follow" ? "overview" : "follow";
      resetMapState();
      maybeRefreshMap();
    } else if (phase === "arrived") {
      stopNavigation("");
    } else {
      frameTimings.finishFrame(frameId, "discarded: navigate ignored click");
      return;
    }
    renderAndSubmit(win, frameId);
    return;
  }
  if (event.type === "scroll-up" || event.type === "scroll-down") {
    if (phase === "navigating" && mapMode === "follow") {
      zoomOffset = Math.max(-3, Math.min(2, zoomOffset + (event.type === "scroll-up" ? 0.5 : -0.5)));
      maybeRefreshMap();
      renderAndSubmit(win, frameId);
    } else {
      frameTimings.finishFrame(frameId, "discarded: navigate ignored scroll");
    }
    return;
  }
  frameTimings.finishFrame(frameId, "discarded: navigate ignored input");
}

// ---------------------------------------------------------------------------
// Painting

function paint(win: NavWindow): Plane[] {
  if (win.menu?.isOpen()) return win.menu.paint();
  return singlePlane(paintContent(win));
}

function paintContent(win: NavWindow): GrayImage {
  const image = new GrayImage(win.viewportWidth, win.viewportHeight, 0);
  if (phase === "idle" || phase === "acquiring" || phase === "routing") {
    paintIdle(image);
  } else {
    paintNavigating(image, win);
  }
  return image;
}

function paintIdle(image: GrayImage): void {
  image.drawText(mediumFont, 24, 16, "Navigate", 245);
  const busy = phase !== "idle";
  const hint = isMapboxConfigured()
    ? "Ask the voice assistant to navigate somewhere, or use Voice input from the long-press menu to say a destination."
    : "Set a Mapbox token in Settings > API Keys to enable navigation.";
  image.drawTextWrapped({ font: smallFont, x: 24, y: 64, width: image.width - 48, text: hint, value: 170 });
  if (statusMessage) {
    image.drawTextWrapped({
      font: smallFont,
      x: 24,
      y: 130,
      width: image.width - 48,
      text: statusMessage,
      value: busy ? 220 : 190,
    });
  }
  drawFooter(image, `${GESTURE_DOUBLE_CLICK} back`);
}

function paintNavigating(image: GrayImage, win: NavWindow): void {
  // Map pane (left).
  if (mapImage) {
    image.bitBlt(mapImage, 0, 0);
    if (mapMode === "follow") drawChevron(image, MAP_SIZE / 2, MAP_SIZE / 2);
  } else {
    image.drawRect(0, 0, MAP_SIZE, MAP_SIZE, 60);
    const text = mapLastError ? "Map unavailable" : "Loading map...";
    image.drawText(smallFont, 24, MAP_SIZE / 2 - 8, text, 120);
  }

  // Guidance panel (right) — its own region so text deltas never overlap the map's.
  const panelWidth = win.viewportWidth - PANEL_X;
  if (phase === "arrived") {
    drawManeuverGlyph(image, PANEL_X + 8, 14, 56, "arrive", "", 245);
    image.drawText(mediumFont, PANEL_X + 76, 26, "Arrived", 245);
    image.drawTextWrapped({
      font: smallFont,
      x: PANEL_X + 8,
      y: 84,
      width: panelWidth - 16,
      text: destinationName,
      value: 200,
    });
    drawFooter(image, `${GESTURE_CLICK} done   ${GESTURE_DOUBLE_CLICK} back`);
    return;
  }

  const step = follower && progress ? follower.route.steps[progress.nextStepIndex] : null;
  if (step && progress) {
    drawManeuverGlyph(image, PANEL_X + 8, 14, 56, step.maneuverType, step.maneuverModifier, 245);
    if (step.exit !== null && (step.maneuverType === "roundabout" || step.maneuverType === "rotary")) {
      image.drawText(smallFont, PANEL_X + 30, 46, String(step.exit), 245);
    }
    image.drawText(largeFont, PANEL_X + 76, 24, formatDistanceShort(progress.metersToNextManeuver), 250);
    image.drawTextWrapped({
      font: mediumFont,
      x: PANEL_X + 8,
      y: 84,
      width: panelWidth - 16,
      text: step.instruction || step.name || step.maneuverType,
      value: 220,
    });
    const eta = `${formatDistance(progress.remainingMeters)} · ${formatDurationShort(progress.remainingSec)} · ${formatClock(
      Date.now() + progress.remainingSec * 1000,
    )}`;
    image.drawText(smallFont, PANEL_X + 8, win.viewportHeight - 62, eta, 170);
  } else {
    image.drawTextWrapped({
      font: mediumFont,
      x: PANEL_X + 8,
      y: 24,
      width: panelWidth - 16,
      text: `Waiting for GPS...`,
      value: 200,
    });
  }
  if (statusMessage) {
    image.drawText(smallFont, PANEL_X + 8, win.viewportHeight - 44, statusMessage, 200);
  }
  const modeHint = mapMode === "follow" ? "overview" : "follow";
  drawFooter(image, `${GESTURE_SCROLL} zoom   ${GESTURE_CLICK} ${modeHint}   ${GESTURE_DOUBLE_CLICK} back`, PANEL_X + 8);
}

/** Position chevron, fixed at the map center (heading-up: it always points up). */
function drawChevron(image: GrayImage, cx: number, cy: number): void {
  // Black halo first so it reads over bright roads.
  fillTriangle(image, cx, cy - 11, cx - 9, cy + 9, cx + 9, cy + 9, 0);
  fillTriangle(image, cx, cy - 8, cx - 6, cy + 6, cx + 6, cy + 6, 255);
}

function fillTriangle(image: GrayImage, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, value: number): void {
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(image.height - 1, Math.ceil(Math.max(y0, y1, y2)));
  for (let y = minY; y <= maxY; y++) {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    const edges: Array<[[number, number], [number, number]]> = [
      [[x0, y0], [x1, y1]],
      [[x1, y1], [x2, y2]],
      [[x2, y2], [x0, y0]],
    ];
    for (const [[ax, ay], [bx, by]] of edges) {
      if ((ay <= y && by >= y) || (by <= y && ay >= y)) {
        if (Math.abs(by - ay) < 0.0001) {
          minX = Math.min(minX, ax, bx);
          maxX = Math.max(maxX, ax, bx);
        } else {
          const t = (y - ay) / (by - ay);
          const x = ax + t * (bx - ax);
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }
    }
    if (minX <= maxX) {
      image.fillRect(Math.round(minX), y, Math.round(maxX - minX) + 1, 1, value);
    }
  }
}

function drawFooter(image: GrayImage, text: string, x = 16): void {
  image.drawText(smallFont, x, image.height - 22, text, 115);
}

// ---------------------------------------------------------------------------
// Formatting (imperial; matches the rest of the UI)

function formatDistanceShort(meters: number): string {
  const feet = meters * 3.28084;
  if (feet < 900) return `${Math.max(0, Math.round(feet / 50) * 50)} ft`;
  return `${(feet / 5280).toFixed(1)} mi`;
}

function formatDistance(meters: number): string {
  const feet = meters * 3.28084;
  if (feet < 1000) return `${Math.max(0, Math.round(feet / 50) * 50)} ft`;
  const miles = feet / 5280;
  return miles >= 10 ? `${Math.round(miles)} mi` : `${miles.toFixed(1)} mi`;
}

function formatDurationShort(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

function formatDurationLong(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} minutes`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatClock(timestampMs: number): string {
  const date = new Date(timestampMs);
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const meridiem = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${meridiem}`;
}

// ---------------------------------------------------------------------------
// Render plumbing

function render(): void {
  if (window) renderAndSubmit(window, 0);
}

function renderAndSubmit(win: NavWindow, inputFrameId: number): void {
  if (!win.foreground && inputFrameId === 0) return;
  const frameId = inputFrameId > 0 ? inputFrameId : frameTimings.startFrame(`render:${win.windowId}`);
  try {
    const paintStartedAtMs = Date.now();
    const planes = frameTimings.span(frameId, "paint", () =>
      frameTimings.runWithFrame(frameId, () => paint(win)),
    );
    const paintMs = Date.now() - paintStartedAtMs;
    const fingerprint = planesFingerprint(planes);
    if (fingerprint === win.lastSubmittedFingerprint) {
      frameTimings.finishFrame(frameId, "discarded: navigate content unchanged");
      return;
    }
    const communicator = getActiveDisplay();
    if (!communicator) {
      frameTimings.finishFrame(frameId, "discarded: no active display");
      return;
    }
    const { image, draws } = frameTimings.span(frameId, "flatten", () => flattenPlanesWithDraws(planes));
    const buffer = frameTimings.span(frameId, "to8bpp", () => image.to8bppBuffer());
    communicator.submitSurfaceFrame(
      buffer.buffer,
      win.surfaceId,
      0,
      0,
      image.width,
      image.height,
      fingerprint,
      paintMs,
      frameId,
      frameTimings.span(frameId, "prepareFrameDraws", () => prepareFrameDraws(draws)),
    );
    win.lastSubmittedFingerprint = fingerprint;
  } catch (error) {
    frameTimings.finishFrame(frameId, "discarded: navigate render failed");
    console.error(`navigate worker render failed: ${error}`);
  }
}
