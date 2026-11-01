import { formatMb, kbToMb, type ResourceSample } from "./resource-usage-types";

export * from "./resource-usage-types";

declare const FaceclawResourceUsage: any;

/**
 * Memory series charted by the resource monitor, headline first: the physical
 * footprint (what jetsam enforces its limit against, and what Xcode's memory
 * gauge shows), resident memory, and bytes in use across the malloc zones.
 */
export const MEMORY_SERIES: readonly string[] = ["footprint", "resident", "malloc"];

const THERMAL_STATES = ["nominal", "fair", "serious", "critical"];

export function sampleResourceUsage(): ResourceSample {
  const raw = JSON.parse(String(FaceclawResourceUsage.sample())) as Record<string, number | boolean | undefined>;
  const kb = (key: string) => kbToMb(Number(raw[key] ?? 0));
  const footprintMb = kb("footprintKb");
  const peakMb = kb("footprintPeakKb");
  const availableMb = kb("availableKb");
  const thermal = THERMAL_STATES[Number(raw.thermalState)];
  return {
    atMs: Number(raw.atMs),
    cpuMs: Number(raw.cpuMs ?? 0),
    threads: Number(raw.threads ?? 0),
    memoryMb: [footprintMb, kb("residentKb"), kb("mallocKb")],
    status: [
      // Footprint plus the remaining headroom is the jetsam limit. No headroom
      // means no limit applies (the simulator) or it was just exceeded.
      availableMb > 0 ? `limit ${formatMb(footprintMb + availableMb)}` : "",
      peakMb > 0 ? `peak ${formatMb(peakMb)}` : "",
      thermal ? `thermal ${thermal}` : "",
      raw.lowPower === true ? "Low Power Mode" : "",
    ].filter(Boolean).join(" · "),
  };
}
