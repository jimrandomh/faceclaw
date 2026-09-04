/**
 * Ambient light sensor access through the custom firmware (CFW image-handler
 * mode 16, capability token "als16"; see g2flash/patches/als_sensor.c).
 *
 * The stock firmware only reads its OPT3001 light sensor while auto-brightness
 * is on, and then steps the panel brightness itself (visible flicker). The CFW
 * adds two things:
 *
 *   - QUERY: one report from the driver's current state.
 *   - PASSIVE polling: the firmware opens and polls the sensor at our interval,
 *     the stock adjuster never touches the panel, and a report arrives when the
 *     reading moved by at least `minDelta` or `heartbeatMs` elapsed. The phone
 *     then applies brightness itself (setBrightness with autoAdjust=false), e.g.
 *     only while the display is blank or during a UI transition.
 *
 * Reports are 24-byte ['A','L',version,...] records on settings field 105.
 */
import { toUint8Array } from "../util/array-util";

declare const com: any;
declare const global: any;

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

function activeCommunicator(): any {
  if (!global.isAndroid) return null;
  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

/** Ask the firmware for one ambient-light report (delivered to listeners). */
export function queryAmbientLight(): void {
  try {
    activeCommunicator()?.queryAmbientLight();
  } catch (error) {
    console.warn(`queryAmbientLight failed: ${error}`);
  }
}

/**
 * Start or stop CFW passive light-sensor polling. Starting is idempotent and
 * re-opens the sensor if the stock firmware closed it, so it is safe to resend
 * on every session start.
 */
export function setAmbientLightPolling(enabled: boolean, options: AmbientLightPollingOptions = {}): void {
  try {
    activeCommunicator()?.setAmbientLightPolling(
      enabled,
      options.intervalMs ?? 500,
      options.minDelta ?? 1,
      options.heartbeatMs ?? 5000,
      options.bindToLease ?? true,
    );
  } catch (error) {
    console.warn(`setAmbientLightPolling failed: ${error}`);
  }
}

/** Subscribe to decoded ambient-light reports. Delivered on the main thread. */
export function addAmbientLightListener(listener: (report: AmbientLightReport) => void): () => void {
  const active = activeCommunicator();
  if (!active) return () => {};
  const proxy = new com.faceclaw.app.FaceclawAmbientLightListener({
    onAmbientLight: (body: any) => {
      const report = decodeAmbientLightReport(toUint8Array(body));
      if (report) listener(report);
    },
  });
  active.addAmbientLightListener(proxy);
  return () => {
    try {
      activeCommunicator()?.removeAmbientLightListener(proxy);
    } catch {
      // The communicator may have been replaced during a disconnect.
    }
  };
}
