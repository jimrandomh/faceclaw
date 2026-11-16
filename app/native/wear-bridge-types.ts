/**
 * The watch transport's wire names and shapes, shared by the Wear OS bridge
 * (wear-bridge.ts) and the Apple Watch one (wear-bridge.ios.ts). See
 * wear/PROTOCOL.md for the messages themselves.
 */

/** Message paths shared with the watch apps (wear/app/.../Protocol.kt, apple-watch/Faceclaw/Protocol.swift). */
export const WEAR_PATHS = {
  /** Watch -> phone: a ring-style gesture. */
  input: "/faceclaw/input",
  /** Watch -> phone: a finger landed on the pad (the ring-press ahead of a gesture); never acked. */
  press: "/faceclaw/press",
  /** Watch -> phone: a shell command (launch app, wake, lock, ...). */
  command: "/faceclaw/command",
  /** Watch -> phone: a text query for the assistant. */
  assistant: "/faceclaw/assistant",
  /** Watch -> phone: text to type into the foreground app. */
  text: "/faceclaw/text",
  /** Watch -> phone: please re-publish the state item. */
  stateRequest: "/faceclaw/state/request",
  /** Watch -> phone: the watch's own battery ({battery, charging}); never acked. */
  battery: "/faceclaw/battery",
  /** Phone -> watch: please report the watch battery (answered even while the watch app is closed). */
  batteryRequest: "/faceclaw/battery/request",
  /** Phone -> watch: reply to any of the above. */
  ack: "/faceclaw/ack",
  /** Phone -> watch: assistant activity, alerts, voice-dialog transcripts. */
  event: "/faceclaw/event",
  /** Phone -> watch Data Layer item: the mirrored dashboard state. */
  state: "/faceclaw/state",
} as const;

export type WearMessage = {
  path: string;
  /** Parsed JSON payload ({} when the watch sent none or it was malformed). */
  payload: Record<string, unknown>;
  nodeId: string;
};

export type WearWatchConnection = {
  reachable: boolean;
  watchName: string;
};

export function parseWearPayload(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
