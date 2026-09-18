declare const com: any;

/**
 * BLE bandwidth benchmark controls (Developer app). The Java communicator
 * streams no-op image payloads for a fixed duration with a selectable message
 * size and pipeline window, then reports throughput. Progress and results are
 * polled with getBandwidthBenchmarkStatus.
 *
 * Talks to the active communicator via the FaceclawBleCommunicator.getActive()
 * static, so it works from any isolate without threading the bridge through.
 */

export type BandwidthBenchmarkStatus = {
  state: "idle" | "starting" | "running" | "done";
  messageSize: number;
  windowSize: number;
  linkMode: number;
  elapsedMs: number;
  messagesSent: number;
  messagesAcked: number;
  timeouts: number;
  payloadBytesAcked: number;
  wireBytesAcked: number;
  aborted: boolean;
};

function activeCommunicator(): any {
  if (!global.isAndroid) return null;
  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

/** Start a run. False if not connected or a run is already active. */
export function startBandwidthBenchmark(messageSize: number, windowSize: number, durationMs: number, linkMode = 0): boolean {
  const active = activeCommunicator();
  if (!active) return false;
  try {
    return Boolean(
      active.startBandwidthBenchmarkWithLinkMode(
        Math.round(messageSize), Math.round(windowSize), Math.round(durationMs), Math.round(linkMode),
      ),
    );
  } catch (error) {
    console.warn(`startBandwidthBenchmark failed: ${error}`);
    return false;
  }
}

/** Cancel an in-progress run. Safe to call when idle. */
export function cancelBandwidthBenchmark(): void {
  try {
    activeCommunicator()?.cancelBandwidthBenchmark();
  } catch (error) {
    console.warn(`cancelBandwidthBenchmark failed: ${error}`);
  }
}

/** Status of the current or most recent run; null when not connected. */
export function getBandwidthBenchmarkStatus(): BandwidthBenchmarkStatus | null {
  const active = activeCommunicator();
  if (!active) return null;
  try {
    return JSON.parse(String(active.getBandwidthBenchmarkStatus())) as BandwidthBenchmarkStatus;
  } catch (error) {
    console.warn(`getBandwidthBenchmarkStatus failed: ${error}`);
    return null;
  }
}
