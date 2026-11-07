import { type ResourceSample } from "./resource-usage-types";
export * from "./resource-usage-types";

export const MEMORY_SERIES: readonly string[] = ["JS heap"];

export function sampleResourceUsage(): ResourceSample {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return { atMs: performance.now(), cpuMs: 0, threads: 1, memoryMb: [(memory?.usedJSHeapSize ?? 0) / (1024 * 1024)], status: "" };
}
