import { formatMb, kbToMb, type ResourceSample } from "./resource-usage-types";

export * from "./resource-usage-types";

declare const com: any;

/**
 * Memory series charted by the resource monitor, headline first: RSS from
 * /proc/self/status (what Android records at exit), the native malloc heap,
 * and the used Java heap.
 */
export const MEMORY_SERIES: readonly string[] = ["RSS", "native", "Java"];

export function sampleResourceUsage(): ResourceSample {
  const raw = com.faceclaw.app.FaceclawResourceUsage.sample();
  const peakRssMb = kbToMb(Number(raw[7]));
  const javaCommittedMb = kbToMb(Number(raw[5]));
  return {
    atMs: Number(raw[0]),
    cpuMs: Number(raw[1]),
    memoryMb: [kbToMb(Number(raw[2])), kbToMb(Number(raw[3])), kbToMb(Number(raw[4]))],
    threads: Number(raw[6]),
    status: [
      peakRssMb > 0 ? `peak RSS ${formatMb(peakRssMb)}` : "",
      `Java heap ${formatMb(javaCommittedMb)} committed`,
    ].filter(Boolean).join(" · "),
  };
}
