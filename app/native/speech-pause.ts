/** Sample-clock pause detection: BLE/network delivery timing is not speech timing. */
export const TRANSCRIPT_PAUSE_MS = 1500;

export class SpeechPauseDetector {
  private noiseFloor = 220;
  private speaking = false;
  private quietSamples = 0;

  reset(): void {
    this.noiseFloor = 220;
    this.speaking = false;
    this.quietSamples = 0;
  }

  /** PCM16LE, 16 kHz. Returns true once per pause after speech. */
  accept(pcm: Uint8Array): boolean {
    const count = pcm.length >> 1;
    if (!count) return false;
    let squares = 0;
    for (let i = 0; i < count; i++) {
      const unsigned = pcm[i * 2]! | (pcm[i * 2 + 1]! << 8);
      const sample = unsigned >= 32768 ? unsigned - 65536 : unsigned;
      squares += sample * sample;
    }
    const rms = Math.sqrt(squares / count);
    const threshold = this.noiseFloor * (this.speaking ? 1.8 : 3);
    if (rms >= threshold) {
      this.speaking = true;
      this.quietSamples = 0;
    } else {
      // Slowly follow background levels without learning speech as noise.
      this.noiseFloor = Math.max(220, this.noiseFloor * 0.98 + rms * 0.02);
      if (this.speaking) {
        this.quietSamples += count;
        if (this.quietSamples >= 16 * TRANSCRIPT_PAUSE_MS) {
          this.speaking = false;
          this.quietSamples = 0;
          return true;
        }
      }
    }
    return false;
  }
}
