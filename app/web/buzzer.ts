/**
 * The glasses' piezo, through Web Audio: the same [5][4][n][freqLo,freqHi,duty,msLo,msHi]*
 * sequences the firmware's tone sequencer plays, as square waves.
 */
let audio: AudioContext | null = null;
let endOfQueue = 0;
let muted = false;

export function setBuzzerMuted(value: boolean): void {
  muted = value;
}

export function isBuzzerMuted(): boolean {
  return muted;
}

export function playBuzzerSequence(payload: Uint8Array): void {
  if (muted || payload.length < 3 || payload[1] !== 0x04) return;
  try {
    audio ??= new AudioContext();
    // Before the first gesture on the page this stays suspended, and silence is right.
    void audio.resume();
    const count = payload[2]!;
    let at = Math.max(audio.currentTime + 0.005, endOfQueue);
    for (let index = 0; index < count; index++) {
      const offset = 3 + index * 5;
      if (offset + 5 > payload.length) break;
      const freq = payload[offset]! | (payload[offset + 1]! << 8);
      const duty = payload[offset + 2]!;
      const ms = payload[offset + 3]! | (payload[offset + 4]! << 8);
      const seconds = ms / 1000;
      if (duty > 0 && freq > 0) {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = "square";
        oscillator.frequency.value = freq;
        // Quiet: a square wave is much louder through speakers than a piezo on your temple.
        const level = 0.05 * Math.min(1, duty / 50);
        gain.gain.setValueAtTime(level, at);
        gain.gain.setValueAtTime(level, at + Math.max(0, seconds - 0.002));
        gain.gain.linearRampToValueAtTime(0, at + seconds);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.start(at);
        oscillator.stop(at + seconds);
      }
      at += seconds;
    }
    endOfQueue = at;
  } catch (error) {
    console.warn(`Buzzer: ${error}`);
  }
}
