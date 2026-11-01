/**
 * Mic level-meter math shared by the Microphones app's meters and the
 * listening header (Transcribe, Translate): RMS mapped onto a 60 dB meter.
 */

/** Meter position in [0,1] for a chunk of 16-bit little-endian PCM. */
export function pcmLevel(pcm: Uint8Array): number {
  let sumSquares = 0;
  const count = pcm.length / 2;
  if (count === 0) return 0;
  for (let i = 0; i < count; i++) {
    let value = pcm[i * 2]! | (pcm[i * 2 + 1]! << 8);
    if (value >= 0x8000) value -= 0x10000;
    sumSquares += value * value;
  }
  return rmsToLevel(Math.sqrt(sumSquares / count) / 32768);
}

/** Map RMS in [0,1] to a meter position with a log-ish curve (mic peaks ~0.1 FS). */
export function rmsToLevel(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}
