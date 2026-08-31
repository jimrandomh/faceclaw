/**
 * TS wrapper for the Java FaceclawWearBridge: the phone side of the Wear OS
 * watch remote. Inbound watch messages arrive as (path, JSON) pairs on the
 * main isolate's thread; outbound calls publish dashboard state and send
 * messages to the watch. The semantic mapping (what a watch "click" does)
 * lives in app/g2/wear-remote.ts; this file only crosses the Java boundary.
 *
 * Every call is a no-op when Google Play services is missing (the Wearable
 * Data Layer is part of it), so the rest of the app never has to care.
 */
import { Utils } from "@nativescript/core";

declare const com: any;

/** Message paths shared with the watch app (wear/app/.../Protocol.kt). */
export const WEAR_PATHS = {
  /** Watch -> phone: a ring-style gesture. */
  input: "/faceclaw/input",
  /** Watch -> phone: a shell command (launch app, wake, lock, ...). */
  command: "/faceclaw/command",
  /** Watch -> phone: a text query for the assistant. */
  assistant: "/faceclaw/assistant",
  /** Watch -> phone: text to type into the foreground app. */
  text: "/faceclaw/text",
  /** Watch -> phone: please re-publish the state item. */
  stateRequest: "/faceclaw/state/request",
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

type MessageListener = (message: WearMessage) => void;
type ConnectionListener = (connection: WearWatchConnection) => void;

class WearBridge {
  private java: any | null | undefined = undefined;
  // The Java-side listener proxy must stay referenced or it gets GC'd.
  private retainedListenerProxy: any = null;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly connectionListeners = new Set<ConnectionListener>();
  private lastConnection: WearWatchConnection = { reachable: false, watchName: "" };

  private getJava(): any | null {
    if (this.java !== undefined) return this.java;
    if (!global.isAndroid) {
      this.java = null;
      return null;
    }
    try {
      const context = Utils.android.getApplicationContext();
      const bridge = context ? com.faceclaw.app.FaceclawWearBridge.getInstance(context) : null;
      this.java = bridge && bridge.isAvailable() ? bridge : null;
    } catch (error) {
      console.warn("wear bridge unavailable", error);
      this.java = null;
    }
    return this.java;
  }

  /** Whether the Wearable Data Layer exists on this phone (Play services). */
  isAvailable(): boolean {
    return this.getJava() !== null;
  }

  private ensureListener(): void {
    if (this.retainedListenerProxy) return;
    const java = this.getJava();
    if (!java) return;
    this.retainedListenerProxy = new com.faceclaw.app.FaceclawWearListener({
      onMessage: (path: string, json: string, nodeId: string) => {
        const message: WearMessage = {
          path: String(path),
          payload: parsePayload(String(json)),
          nodeId: String(nodeId),
        };
        for (const listener of Array.from(this.messageListeners)) {
          try {
            listener(message);
          } catch (error) {
            console.warn("wear message listener failed", error);
          }
        }
      },
      onWatchConnection: (reachable: boolean, watchName: string) => {
        this.lastConnection = { reachable: Boolean(reachable), watchName: String(watchName ?? "") };
        for (const listener of Array.from(this.connectionListeners)) {
          try {
            listener(this.lastConnection);
          } catch (error) {
            console.warn("wear connection listener failed", error);
          }
        }
      },
    });
    java.setListener(this.retainedListenerProxy);
  }

  /** Subscribe to watch messages. Registers the Java listener on first use. */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    this.ensureListener();
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /** Subscribe to watch reachability; the current value is delivered immediately. */
  onWatchConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    this.ensureListener();
    listener(this.getWatchConnection());
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  getWatchConnection(): WearWatchConnection {
    const java = this.getJava();
    if (!java) return { reachable: false, watchName: "" };
    try {
      return {
        reachable: Boolean(java.isWatchReachable()),
        watchName: String(java.getWatchName() ?? ""),
      };
    } catch {
      return this.lastConnection;
    }
  }

  /** Re-query reachable watches (e.g. when the phone UI wants a fresh answer). */
  refreshWatchNodes(): void {
    this.getJava()?.refreshWatchNodes();
  }

  /**
   * Mirror the dashboard state to the watch. Unchanged states are dropped on
   * the Java side unless `force` (a watch explicitly asked for a refresh).
   */
  publishState(state: Record<string, unknown>, force = false): void {
    this.getJava()?.publishState(JSON.stringify(state), force);
  }

  /** Send an event to every reachable watch. */
  sendEvent(payload: Record<string, unknown>): void {
    this.getJava()?.sendToWatch(WEAR_PATHS.event, JSON.stringify(payload));
  }

  /** Acknowledge a watch message; `seq` echoes the watch's sequence number. */
  sendAck(nodeId: string, seq: number, ok: boolean, message = ""): void {
    this.getJava()?.sendAck(nodeId, seq, ok, true, message);
  }
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export const wearBridge = new WearBridge();
