import { WEAR_PATHS, type WearMessage, type WearWatchConnection } from "./wear-bridge-types";
export { WEAR_PATHS, type WearMessage, type WearWatchConnection };

/** No watch can pair with a browser tab. */
class WearBridge {
  isAvailable(): boolean { return false; }
  onMessage(_listener: (message: WearMessage) => void): () => void { return () => {}; }
  onWatchConnection(_listener: (connection: WearWatchConnection) => void): () => void { return () => {}; }
  getWatchConnection(): WearWatchConnection { return { reachable: false, watchName: "" }; }
  refreshWatchNodes(): void {}
  publishState(_state: Record<string, unknown>, _force = false): void {}
  sendEvent(_payload: Record<string, unknown>): void {}
  sendToWatch(_path: string, _payload: Record<string, unknown>): void {}
  sendAck(_nodeId: string, _seq: number, _ok: boolean, _message = ""): void {}
}

export const wearBridge = new WearBridge();
