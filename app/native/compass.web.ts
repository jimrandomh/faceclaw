/** A wandering heading stands in for the G2's magnetometer. */
import { COMPASS_CHANGED, type CompassEvent } from "./compass-types";

export * from "./compass-types";

const listeners = new Set<(event: CompassEvent) => void>();
const owners = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

function heading(nowMs: number): number {
  const seconds = nowMs / 1000;
  const degrees = 40 + 75 * Math.sin(seconds / 7) + 30 * Math.sin(seconds / 2.3);
  return ((degrees % 360) + 360) % 360;
}

function sync(): void {
  if (owners.size > 0 && timer === null) {
    timer = setInterval(() => {
      const now = Date.now();
      const event: CompassEvent = {
        command: COMPASS_CHANGED,
        headingDegrees: heading(now),
        diagnostics: { magneticAccuracy: 3, magneticAnomalies: 0, orientationSource: 3, flags: 0, sampleTimeMs: now },
      };
      for (const listener of [...listeners]) listener(event);
    }, 100);
  } else if (owners.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export function setCompassEnabled(enabled: boolean, owner = "compass"): void {
  if (enabled) owners.add(owner);
  else owners.delete(owner);
  sync();
}

export function addCompassListener(listener: (event: CompassEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
