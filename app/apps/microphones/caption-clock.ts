// Utterance times come from the caption engine's sample clock, which only
// advances with audio fed to it. Audio that never reaches the engine (beam
// filtered, paused for the voice dialog, lost to a stall) would otherwise
// shift every later line earlier, so the clock is re-anchored to wall time
// (arrival time, so ordinary BLE jitter is tolerated) whenever the two drift
// this far apart, in either direction: missing audio puts wall time ahead,
// and a backlog delivered late in a burst puts it behind once the stream
// catches up.
export const CAPTION_CLOCK_DRIFT_MS = 300;
const MAX_ANCHORS = 1000;

/** Maps a caption engine's clock (ms of audio fed to it) to wall time. */
export class CaptionClock {
  private fedSamples = 0;
  // Engine-clock times with the wall time each corresponds to, in order.
  private readonly anchors: Array<{ engineMs: number; wallMs: number }> = [];

  constructor(
    private readonly sampleRate: number,
    private readonly startWallMs: number,
  ) {}

  /** `bytes` of 16-bit mono PCM were fed to the engine, arriving at `nowMs`. */
  noteFed(bytes: number, nowMs: number): void {
    const samples = Math.floor(bytes / 2);
    const engineMs = (this.fedSamples * 1000) / this.sampleRate;
    this.fedSamples += samples;
    // The chunk arrived as it ended; its first sample is that much older.
    const wallMs = nowMs - (samples * 1000) / this.sampleRate;
    const last = this.anchors[this.anchors.length - 1];
    if (last && Math.abs(wallMs - (last.wallMs + engineMs - last.engineMs)) <= CAPTION_CLOCK_DRIFT_MS) return;
    this.anchors.push({ engineMs, wallMs });
    if (this.anchors.length > MAX_ANCHORS) this.anchors.shift();
  }

  /** Wall time of a moment on the engine's clock. */
  wallMs(engineMs: number): number {
    for (let i = this.anchors.length - 1; i >= 0; i--) {
      const anchor = this.anchors[i]!;
      if (anchor.engineMs <= engineMs) return anchor.wallMs + engineMs - anchor.engineMs;
    }
    return this.startWallMs + engineMs;
  }
}
