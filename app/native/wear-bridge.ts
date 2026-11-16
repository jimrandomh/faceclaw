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
import { WEAR_PATHS, parseWearPayload, type WearMessage, type WearWatchConnection } from "./wear-bridge-types";

export { WEAR_PATHS, type WearMessage, type WearWatchConnection };

declare const com: any;

type MessageListener = (message: WearMessage) => void;
type ConnectionListener = (connection: WearWatchConnection) => void;

class WearBridge {
  private java: any = undefined;
  // The Java-side listener proxy must stay referenced or it gets GC'd.
  private retainedListenerProxy: any = null;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly connectionListeners = new Set<ConnectionListener>();
  private lastConnection: WearWatchConnection = { reachable: false, watchName: "" };

  private getJava(): any {
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
          payload: parseWearPayload(String(json)),
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
    this.sendToWatch(WEAR_PATHS.event, payload);
  }

  /** Send a message on any phone -> watch path to every reachable watch. */
  sendToWatch(path: string, payload: Record<string, unknown>): void {
    this.getJava()?.sendToWatch(path, JSON.stringify(payload));
  }

  /** Acknowledge a watch message; `seq` echoes the watch's sequence number. */
  sendAck(nodeId: string, seq: number, ok: boolean, message = ""): void {
    this.getJava()?.sendAck(nodeId, seq, ok, true, message);
  }
}

export const wearBridge = new WearBridge();
