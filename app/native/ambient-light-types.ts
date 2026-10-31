/**
 * Platform-neutral ambient-light types and the CFW report decoder (settings
 * field 105), shared by ambient-light.ts and ambient-light.ios.ts.
 */

export const ALS_REPORT_VERSION = 1;

export type AmbientLightReason = "query" | "started" | "poll" | "stopped";

export type AmbientLightReport = {
  reason: AmbientLightReason;
  /** The sensor driver is open (readings are live). */
  opened: boolean;
  /** CFW passive polling is installed (stock auto-brightness is not stepping). */
  passive: boolean;
  /** The user's stock auto-brightness setting is on. */
  autoBrightness: boolean;
  /** The last passive read succeeded (only meaningful while passive). */
  readOk: boolean;
  /** Stock driver status: 1 start-read, 2 adjusting, 3 polling. */
  status: number;
  /** Ambient light in the stock driver's units (roughly tenths of a lux). */
  alsValue: number;
  /** Max of the last five readings (what the stock curve is applied to). */
  peak: number;
  /** Brightness level (0..100) the stock curve would choose for `peak`. */
  stockTarget: number;
  /** Current brightness setting (0..100). */
  brightness: number;
  /** Row of the stock brightness curve (0..5) for `peak`. */
  gear: number;
  /** Stock learned scale factor, Q10 (1024 = 1.0). */
  scaleQ10: number;
  /** Firmware millisecond tick when the report was built. */
  tickMs: number;
};

const REASONS: AmbientLightReason[] = ["query", "started", "poll", "stopped"];

function rd16(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8);
}

function rd32(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

/** Decode a field-105 record body, or null when it isn't one. */
export function decodeAmbientLightReport(body: Uint8Array): AmbientLightReport | null {
  if (body.length < 24 || body[0] !== 0x41 || body[1] !== 0x4c || body[2] !== ALS_REPORT_VERSION) {
    return null;
  }
  const flags = body[4];
  return {
    reason: REASONS[body[3]] ?? "poll",
    opened: (flags & 0x01) !== 0,
    passive: (flags & 0x02) !== 0,
    autoBrightness: (flags & 0x04) !== 0,
    readOk: (flags & 0x08) !== 0,
    status: body[5],
    alsValue: rd32(body, 6),
    peak: rd32(body, 10),
    stockTarget: rd16(body, 14),
    brightness: body[16],
    gear: body[17],
    scaleQ10: rd16(body, 18),
    tickMs: rd32(body, 20),
  };
}

export type AmbientLightPollingOptions = {
  /** Poll period in ms; the firmware clamps to 100..5000. Default 500. */
  intervalMs?: number;
  /** Report when the reading moved by at least this much. Default 1. */
  minDelta?: number;
  /** Also report after this many ms without one (0 = never). Default 5000. */
  heartbeatMs?: number;
  /**
   * Stop automatically when the Faceclaw framebuffer lease is released or
   * lapses (the phone went away). Default true.
   */
  bindToLease?: boolean;
};

/** The options with their defaults filled in. */
export function resolvePollingOptions(options: AmbientLightPollingOptions): Required<AmbientLightPollingOptions> {
  return {
    intervalMs: options.intervalMs ?? 500,
    minDelta: options.minDelta ?? 1,
    heartbeatMs: options.heartbeatMs ?? 5000,
    bindToLease: options.bindToLease ?? true,
  };
}
