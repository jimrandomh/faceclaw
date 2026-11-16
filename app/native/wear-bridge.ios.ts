/**
 * iOS twin of wear-bridge.ts: the phone side of the Apple Watch remote, over
 * WatchConnectivity (App_Resources/iOS/src/FaceclawWatchBridge). It has the
 * same surface and carries the same (path, JSON) messages, so
 * app/g2/wear-remote.ts gives them their meaning on both platforms.
 *
 * "Reachable" here means an Apple Watch with the Faceclaw app is paired, not
 * that the app is running: iOS can't wake a closed watch app, and it is
 * suspended whenever the wrist drops, so WCSession's live reachability flips
 * constantly. The native side sends live while it can and otherwise leaves
 * the latest state in the application context for the app's next wake.
 */
import { WEAR_PATHS, parseWearPayload, type WearMessage, type WearWatchConnection } from './wear-bridge-types'

export { WEAR_PATHS, type WearMessage, type WearWatchConnection }

declare const FaceclawWatchBridge: any

/** WatchConnectivity doesn't expose the watch's own name. */
const WATCH_NAME = 'Apple Watch'
/** Replies go to the session's one counterpart; this only fills WearMessage.nodeId. */
const WATCH_NODE_ID = 'apple-watch'

type MessageListener = (message: WearMessage) => void
type ConnectionListener = (connection: WearWatchConnection) => void

class WearBridge {
  private nativeBridge: any = undefined
  private listening = false
  private readonly messageListeners = new Set<MessageListener>()
  private readonly connectionListeners = new Set<ConnectionListener>()

  private native(): any {
    if (this.nativeBridge !== undefined) return this.nativeBridge
    try {
      const bridge = FaceclawWatchBridge.shared()
      this.nativeBridge = bridge.isAvailable() ? bridge : null
    } catch (error) {
      console.warn('watch bridge unavailable', error)
      this.nativeBridge = null
    }
    return this.nativeBridge
  }

  /** Whether WatchConnectivity works on this phone (it does on every iPhone). */
  isAvailable(): boolean {
    return this.native() !== null
  }

  private ensureListener(): void {
    if (this.listening) return
    const native = this.native()
    if (!native) return
    this.listening = true
    native.setMessageHandlerConnectionHandler((path: string, json: string) => {
      const message: WearMessage = { path: String(path), payload: parseWearPayload(String(json)), nodeId: WATCH_NODE_ID }
      for (const listener of Array.from(this.messageListeners)) {
        try { listener(message) }
        catch (error) { console.warn('watch message listener failed', error) }
      }
    }, () => {
      const connection = this.getWatchConnection()
      for (const listener of Array.from(this.connectionListeners)) {
        try { listener(connection) }
        catch (error) { console.warn('watch connection listener failed', error) }
      }
    })
  }

  /** Subscribe to watch messages. Registers the native listener on first use. */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener)
    this.ensureListener()
    return () => { this.messageListeners.delete(listener) }
  }

  /**
   * Subscribe to the watch's availability; the current value is delivered
   * immediately. Also fires when the watch app comes to the front with the
   * value unchanged, which is what prompts WearRemote to push it fresh state.
   */
  onWatchConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener)
    this.ensureListener()
    listener(this.getWatchConnection())
    return () => { this.connectionListeners.delete(listener) }
  }

  getWatchConnection(): WearWatchConnection {
    const reachable = Boolean(this.native()?.isWatchAppAvailable())
    return { reachable, watchName: reachable ? WATCH_NAME : '' }
  }

  /** WatchConnectivity pushes changes; there is nothing to re-query. */
  refreshWatchNodes(): void {}

  /** Mirror the dashboard state; unchanged states are dropped natively unless `force`. */
  publishState(state: Record<string, unknown>, force = false): void {
    this.native()?.publishStateForce(JSON.stringify(state), force)
  }

  /**
   * Send an event to the watch. A suspended app misses live messages, so all
   * but streaming snapshots also stay behind for its next wake: that is how a
   * reply that finished with the wrist down still reaches the Assistant screen.
   */
  sendEvent(payload: Record<string, unknown>): void {
    const sticky = !(payload.type === 'assistant' && payload.phase === 'streaming')
    this.native()?.sendEventSticky(JSON.stringify(payload), sticky)
  }

  /** Send a live message on any phone -> watch path; dropped if the app isn't in front. */
  sendToWatch(path: string, payload: Record<string, unknown>): void {
    this.native()?.sendToWatchJson(path, JSON.stringify(payload))
  }

  /** Acknowledge a watch message; `seq` echoes the watch's sequence number. */
  sendAck(_nodeId: string, seq: number, ok: boolean, message = ''): void {
    this.native()?.sendAckOkJsReadyMessage(seq, ok, true, message)
  }
}

export const wearBridge = new WearBridge()
