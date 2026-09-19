declare const com: any;

export interface BleTrafficSample {
  /** Outbound messages (writeFrames calls) since process start. */
  messages: number;
  /** Outbound payload bytes (sum of frame sizes) since process start. */
  bytes: number;
  /** Display frames whose last message was acked, since process start. */
  frames: number;
}

/** Running totals of outbound BLE traffic, counted process-wide in FaceclawBleManager. */
export function sampleBleTraffic(): BleTrafficSample {
  const raw = com.faceclaw.app.FaceclawBleManager.sampleOutboundTraffic();
  return { messages: Number(raw[0]), bytes: Number(raw[1]), frames: Number(raw[2]) };
}
