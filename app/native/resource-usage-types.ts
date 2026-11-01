/** Platform-neutral process resource sample, shared by resource-usage.ts and resource-usage.ios.ts. */

export type ResourceSample = {
  /** Monotonic clock (counting deep sleep), ms. */
  atMs: number;
  /** Cumulative CPU time of every thread in the process, ms. */
  cpuMs: number;
  threads: number;
  /** One value per entry of the platform's MEMORY_SERIES, MiB. */
  memoryMb: number[];
  /** Platform-specific details for the latest sample (peaks, limits, thermal state). */
  status: string;
};

export function kbToMb(kb: number): number {
  return Number.isFinite(kb) ? Math.max(0, kb) / 1024 : 0;
}

export function formatMb(value: number): string {
  if (value >= 1024) return `${(value / 1024).toFixed(1)}G`;
  return `${Math.round(value)}M`;
}
