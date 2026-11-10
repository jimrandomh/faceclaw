/**
 * Shapes shared by the Neural Band bridge (neural-band.ts, Android) and its iOS stub
 * (neural-band.ios.ts). The events come from FaceclawNeuralBand.kt as JSON objects.
 */

/** Where the band connection is. "claiming" is the first connection, which takes the band over from its Meta account. */
export type NeuralBandState = "idle" | "disconnected" | "connecting" | "claiming" | "connected" | "error";

export type NeuralBandStatus = {
  /** False on a phone that can't host the band at all (Android < 10, iOS for now). */
  supported: boolean;
  state: NeuralBandState;
  /** Progress or the last problem, for the setup page; "" when there is nothing to say. */
  message: string;
  /** The Meta session was found expired: sign in again before claiming. */
  sessionExpired: boolean;
  /** A band is remembered. */
  paired: boolean;
  address: string;
  name: string;
  /** The remembered band has a stored identity: it reconnects without the Meta account. */
  claimed: boolean;
  metaSignedIn: boolean;
  /** 0-100, or -1 while unknown. */
  battery: number;
  charging: boolean | null;
  /** The wrist the band is set up for, once it has said. */
  hand: "left" | "right" | null;
  firmware: string;
  /** A pairing scan is running. */
  scanning: boolean;
};

/**
 * One gesture. `press`/`hold`/`release` are pinch edges (a hold is a pinch that has lasted
 * 0.4 s; an index pinch that became the dial never holds); `tap`/`double-tap` arrive once the
 * double-tap window has passed. `finger` is 0 for index, 1 for middle; thumb swipes and the
 * dial carry none.
 */
export type NeuralBandGesture =
  | "press" | "hold" | "release" | "tap" | "double-tap"
  | "swipe-up" | "swipe-down" | "swipe-left" | "swipe-right"
  | "dial-up" | "dial-down";

export type NeuralBandEvent =
  | ({ type: "status" } & NeuralBandStatus)
  | { type: "gesture"; gesture: NeuralBandGesture; finger?: number }
  | { type: "discovered"; name: string; address: string; rssi: number }
  | { type: "log"; text: string };

export const UNSUPPORTED_STATUS: NeuralBandStatus = {
  supported: false,
  state: "idle",
  message: "",
  sessionExpired: false,
  paired: false,
  address: "",
  name: "",
  claimed: false,
  metaSignedIn: false,
  battery: -1,
  charging: null,
  hand: null,
  firmware: "",
  scanning: false,
};

/** Parse one event from the native side; null for anything malformed. */
export function parseNeuralBandEvent(json: string): NeuralBandEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const event = value as { type?: unknown };
  if (event.type === "status") return { ...UNSUPPORTED_STATUS, ...(value as object), type: "status" } as NeuralBandEvent;
  if (event.type === "gesture" || event.type === "discovered" || event.type === "log") return value as NeuralBandEvent;
  return null;
}
