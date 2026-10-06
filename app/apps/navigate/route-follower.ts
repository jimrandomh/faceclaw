/**
 * Client-side route following: snap GPS fixes to the route polyline, track
 * progress toward the next maneuver, and detect off-route/arrival. Pure
 * geometry over the Directions response — no network, no Android.
 */
import type { Route } from "../../native/mapbox";

const EARTH_RADIUS_M = 6_371_000;
/** Perpendicular distance that counts as off the route. */
const OFF_ROUTE_THRESHOLD_M = 50;
/** Consecutive off-route fixes before declaring a reroute is needed. */
const OFF_ROUTE_FIX_COUNT = 3;
/** Within this many meters of the destination counts as arrived. */
const ARRIVAL_THRESHOLD_M = 35;
/** How far behind the last known progress the snap search may look. */
const SNAP_BACKTRACK_SEGMENTS = 8;
/** How far ahead of the last known progress the snap search may look. */
const SNAP_LOOKAHEAD_SEGMENTS = 120;

export type RouteProgress = {
  /** Snapped position [lon, lat]. */
  snapped: [number, number];
  /** Meters traveled along the route. */
  alongMeters: number;
  /** Perpendicular meters from the fix to the route. */
  crossTrackMeters: number;
  /** Index of the upcoming maneuver in route.steps (its instruction is what to show). */
  nextStepIndex: number;
  /** Meters until the upcoming maneuver. */
  metersToNextManeuver: number;
  remainingMeters: number;
  remainingSec: number;
  offRoute: boolean;
  arrived: boolean;
};

export class RouteFollower {
  readonly route: Route;
  /** Cumulative meters from the origin to each geometry vertex. */
  private readonly vertexMeters: number[];
  /** Meters along the route at which each step's maneuver occurs. */
  private readonly stepStartMeters: number[];
  private readonly totalMeters: number;
  private lastSegmentIndex = 0;
  private offRouteStreak = 0;

  constructor(route: Route) {
    this.route = route;
    this.vertexMeters = Array.from({ length: route.coordinates.length }, () => 0);
    let along = 0;
    this.vertexMeters[0] = 0;
    for (let i = 1; i < route.coordinates.length; i++) {
      along += haversineMeters(route.coordinates[i - 1]!, route.coordinates[i]!);
      this.vertexMeters[i] = along;
    }
    this.totalMeters = along;

    // Each step's maneuver happens where the previous step's travel ends, so
    // the maneuver point of step k sits at the sum of steps 0..k-1 distances.
    // (Slight drift vs the geometry is fine at guidance granularity.)
    this.stepStartMeters = Array.from({ length: route.steps.length }, () => 0);
    let stepAlong = 0;
    for (let i = 0; i < route.steps.length; i++) {
      this.stepStartMeters[i] = Math.min(stepAlong, this.totalMeters);
      stepAlong += route.steps[i]!.distanceMeters;
    }
  }

  /** Ingest a GPS fix and return current guidance state. */
  update(longitude: number, latitude: number): RouteProgress {
    const fix: [number, number] = [longitude, latitude];
    const snap = this.snapToRoute(fix);
    this.lastSegmentIndex = snap.segmentIndex;

    if (snap.crossTrackMeters > OFF_ROUTE_THRESHOLD_M) {
      this.offRouteStreak++;
    } else {
      this.offRouteStreak = 0;
    }

    const remainingMeters = Math.max(0, this.totalMeters - snap.alongMeters);
    const arrived =
      remainingMeters < ARRIVAL_THRESHOLD_M &&
      haversineMeters(fix, this.route.coordinates[this.route.coordinates.length - 1]!) <
        ARRIVAL_THRESHOLD_M * 2;

    // The next maneuver is the first one still ahead of us. Step 0 is
    // "depart", which is behind us as soon as we move; arrival is last.
    let nextStepIndex = this.route.steps.length - 1;
    for (let i = 1; i < this.route.steps.length; i++) {
      if (this.stepStartMeters[i]! > snap.alongMeters + 5) {
        nextStepIndex = i;
        break;
      }
    }

    return {
      snapped: snap.snapped,
      alongMeters: snap.alongMeters,
      crossTrackMeters: snap.crossTrackMeters,
      nextStepIndex,
      metersToNextManeuver: Math.max(0, this.stepStartMeters[nextStepIndex]! - snap.alongMeters),
      remainingMeters,
      remainingSec: this.remainingSeconds(snap.alongMeters, nextStepIndex),
      offRoute: this.offRouteStreak >= OFF_ROUTE_FIX_COUNT,
      arrived,
    };
  }

  totalRouteMeters(): number {
    return this.totalMeters;
  }

  /**
   * The route geometry from just behind the current position to aheadMeters
   * past it — the slice worth drawing on a follow-mode map.
   */
  routeSliceAround(alongMeters: number, behindMeters: number, aheadMeters: number): Array<[number, number]> {
    const from = Math.max(0, alongMeters - behindMeters);
    const to = Math.min(this.totalMeters, alongMeters + aheadMeters);
    const slice: Array<[number, number]> = [];
    for (let i = 0; i < this.route.coordinates.length; i++) {
      const at = this.vertexMeters[i]!;
      if (at < from) continue;
      if (at > to) break;
      slice.push(this.route.coordinates[i]!);
    }
    return slice.length >= 2 ? slice : this.route.coordinates.slice(0, 2);
  }

  /**
   * Nearest point on the polyline, biased to search near the last known
   * segment first so parallel roads and overlaps resolve forward along the
   * route. Falls back to a whole-route search when the local window misses.
   */
  private snapToRoute(fix: [number, number]): {
    snapped: [number, number];
    alongMeters: number;
    crossTrackMeters: number;
    segmentIndex: number;
  } {
    const windowStart = Math.max(0, this.lastSegmentIndex - SNAP_BACKTRACK_SEGMENTS);
    const windowEnd = Math.min(
      this.route.coordinates.length - 2,
      this.lastSegmentIndex + SNAP_LOOKAHEAD_SEGMENTS,
    );
    const local = this.nearestOnSegments(fix, windowStart, windowEnd);
    if (local && local.crossTrackMeters <= OFF_ROUTE_THRESHOLD_M * 2) {
      return local;
    }
    const global = this.nearestOnSegments(fix, 0, this.route.coordinates.length - 2);
    return global ?? local ?? {
      snapped: this.route.coordinates[0]!,
      alongMeters: 0,
      crossTrackMeters: Number.POSITIVE_INFINITY,
      segmentIndex: 0,
    };
  }

  private nearestOnSegments(
    fix: [number, number],
    firstSegment: number,
    lastSegment: number,
  ): { snapped: [number, number]; alongMeters: number; crossTrackMeters: number; segmentIndex: number } | null {
    let best: { snapped: [number, number]; alongMeters: number; crossTrackMeters: number; segmentIndex: number } | null =
      null;
    // Planar approximation in a locally scaled lon/lat frame; fine for
    // segment-scale distances.
    const cosLat = Math.cos((fix[1] * Math.PI) / 180);
    for (let i = firstSegment; i <= lastSegment; i++) {
      const a = this.route.coordinates[i]!;
      const b = this.route.coordinates[i + 1]!;
      const ax = (a[0] - fix[0]) * cosLat;
      const ay = a[1] - fix[1];
      const bx = (b[0] - fix[0]) * cosLat;
      const by = b[1] - fix[1];
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq > 0 ? clamp01(-(ax * dx + ay * dy) / lengthSq) : 0;
      const px = ax + t * dx;
      const py = ay + t * dy;
      const distanceMeters = Math.sqrt(px * px + py * py) * ((Math.PI / 180) * EARTH_RADIUS_M);
      if (best === null || distanceMeters < best.crossTrackMeters) {
        const segmentLength = this.vertexMeters[i + 1]! - this.vertexMeters[i]!;
        best = {
          snapped: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
          alongMeters: this.vertexMeters[i]! + t * segmentLength,
          crossTrackMeters: distanceMeters,
          segmentIndex: i,
        };
      }
    }
    return best;
  }

  private remainingSeconds(alongMeters: number, nextStepIndex: number): number {
    // Whole steps still ahead, plus a proportional share of the step we're in.
    let seconds = 0;
    for (let i = nextStepIndex; i < this.route.steps.length; i++) {
      seconds += this.route.steps[i]!.durationSec;
    }
    const currentStep = this.route.steps[nextStepIndex - 1];
    if (currentStep && currentStep.distanceMeters > 0) {
      const stepStart = this.stepStartMeters[nextStepIndex - 1]!;
      const fractionRemaining = clamp01(1 - (alongMeters - stepStart) / currentStep.distanceMeters);
      seconds += currentStep.durationSec * fractionRemaining;
    }
    return seconds;
  }
}

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing (degrees clockwise from north) from a to b. */
export function bearingDegrees(a: [number, number], b: [number, number]): number {
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
