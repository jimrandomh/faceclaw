import { CFW_MSG_BUZZER } from "../g2/cfw-message-type";
/**
 * Sound-effect catalog for the CFW buzzer tone sequencer (load_image_z mode 5
 * kind 4). Ported from g2-kit-unofficial/examples/tunes.ts.
 *
 * The G2 "speaker" is a single monophonic PWM piezo buzzer. One message
 * carries up to 48 back-to-back {freq, duty, ms} steps that the firmware
 * plays on its own one-shot timer (non-blocking, auto-stops after the last
 * step). Effects longer than 48 steps split into phrases, each its own
 * message sent back-to-back, broken at musical rests so the tiny
 * inter-message gap is inaudible.
 *
 * Piezo reality check: the element resonates best around ~1-4 kHz; below
 * ~150 Hz it is faint, above ~8 kHz it thins out. duty ~50% is the fullest
 * square wave; lower duty reads as thinner and quieter.
 */

/** One PWM segment; duty 0 means "rest" (silence) for `ms`. */
export type Step = { freq: number; duty?: number; ms: number };
/** One or more phrases; each phrase is one sequencer message. */
export type Effect = Step[] | Step[][];

/** Mirrors CFW_SEQ_MAX in g2flash/patches/cfw_context.h. */
export const CFW_SEQ_MAX = 48;

/** Build the wire buffer: [5][4][nSteps][ freqLo,freqHi,duty,msLo,msHi ]*n. */
export function buildSoundSequencePayload(steps: Step[]): Uint8Array {
  const count = Math.min(steps.length, CFW_SEQ_MAX);
  const out = new Uint8Array(3 + count * 5);
  out[0] = CFW_MSG_BUZZER;
  out[1] = 0x04;
  out[2] = count;
  for (let index = 0; index < count; index++) {
    const { freq, duty = 50, ms } = steps[index]!;
    const offset = 3 + index * 5;
    const clampedFreq = Math.max(1, Math.min(20000, Math.round(freq)));
    const clampedDuty = Math.max(0, Math.min(100, Math.round(duty)));
    const clampedMs = Math.max(1, Math.min(65535, Math.round(ms)));
    out[offset] = clampedFreq & 0xff;
    out[offset + 1] = (clampedFreq >> 8) & 0xff;
    out[offset + 2] = clampedDuty;
    out[offset + 3] = clampedMs & 0xff;
    out[offset + 4] = (clampedMs >> 8) & 0xff;
  }
  return out;
}

export function phraseDurationMs(steps: Step[]): number {
  return steps.reduce((total, step) => total + step.ms, 0);
}

/** Normalize an Effect into its list of phrases. */
export function effectPhrases(effect: Effect): Step[][] {
  return Array.isArray(effect[0]) ? (effect as Step[][]) : [effect as Step[]];
}

/** Look up a catalog effect by name (e.g. "questcomplete"). */
export function findSoundEffect(name: string): SoundEffect | undefined {
  return SOUND_EFFECTS.find((effect) => effect.name === name);
}

/**
 * Play an effect through `play`, pacing phrase-by-phrase (and chunking any
 * over-long phrase to the firmware's per-message cap) so each sequencer
 * message lands as the previous phrase finishes.
 */
export async function playSoundEffect(
  effect: SoundEffect,
  play: (payload: Uint8Array) => Promise<void> | void,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (const phrase of effectPhrases(effect.make())) {
    for (let index = 0; index < phrase.length; index += CFW_SEQ_MAX) {
      const chunk = phrase.slice(index, index + CFW_SEQ_MAX);
      await play(buildSoundSequencePayload(chunk));
      await sleep(phraseDurationMs(chunk));
    }
  }
}

// ============================ musical helpers ===============================
// Equal-tempered pitch from a name like "A4", "C#5", "Bb3". A4 = 440 Hz.
const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function hz(name: string): number {
  const match = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name.trim());
  if (!match) throw new Error(`bad note: ${name}`);
  let semitone = SEMI[match[1]!.toUpperCase()]!;
  if (match[2] === "#") semitone += 1;
  else if (match[2] === "b") semitone -= 1;
  const midi = semitone + (parseInt(match[3]!, 10) + 1) * 12;
  return Math.round(440 * 2 ** ((midi - 69) / 12));
}

// Compact melody DSL: whitespace-separated "NOTE/ms" tokens. "." or "r" = rest.
function notes(dsl: string, defMs = 140, duty = 50): Step[] {
  return dsl.trim().split(/\s+/).map((token) => {
    const [note, durationText] = token.split("/");
    const ms = durationText ? parseInt(durationText, 10) : defMs;
    if (note === "." || note === "r" || note === "rest") return { freq: 1, duty: 0, ms };
    return { freq: hz(note!), duty, ms };
  });
}

// Geometric (log-linear = constant perceived glide) frequency sweep across
// `ms`, approximated by `steps` short constant-tone segments.
function sweep(from: number, to: number, ms: number, steps = 16, duty = 50): Step[] {
  steps = Math.max(2, Math.min(CFW_SEQ_MAX, steps));
  const per = Math.max(1, ms / steps);
  const out: Step[] = [];
  for (let index = 0; index < steps; index++) {
    const freq = from * (to / from) ** (index / (steps - 1));
    out.push({ freq, duty, ms: per });
  }
  return out;
}

const cat = (...parts: Step[][]): Step[] => parts.flat();
const rest = (ms: number): Step => ({ freq: 1, duty: 0, ms });
const rep = (steps: Step[], n: number): Step[] => Array.from({ length: n }, () => steps).flat();

// ================================ catalog ===================================
// Each effect keeps every phrase <= 48 steps. Ordered roughly best-first.
export type SoundEffect = { name: string; desc: string; make: () => Effect };

export const SOUND_EFFECTS: SoundEffect[] = [
  // --- game SFX ---
  { name: "coin", desc: "Mario coin: blip then a bright ring", make: () =>
      notes("B5/70 E6/520") },
  { name: "powerup", desc: "ascending arpeggio glissando", make: () => {
      const out: Step[] = [];
      const cells = ["G4", "C5", "E5", "G5", "C6", "E6", "G6"];
      for (const cell of cells) out.push({ freq: hz(cell), duty: 50, ms: 42 });
      out.push(rest(20), { freq: hz("G6"), duty: 50, ms: 60 },
               { freq: hz("C7"), duty: 50, ms: 120 });
      return out;
    } },
  { name: "oneup", desc: "Mario 1-UP jingle", make: () =>
      notes("E5/130 G5/130 E6/130 C6/130 D6/130 G6/300") },
  { name: "laser", desc: "downward pew, 1.8k -> 320 Hz", make: () =>
      sweep(1800, 320, 190, 26, 50) },
  { name: "pew", desc: "short high blaster", make: () =>
      sweep(2800, 700, 80, 12, 45) },
  { name: "zap", desc: "up-then-down electric snap", make: () =>
      cat(sweep(400, 2300, 55, 9), sweep(2300, 260, 95, 13)) },
  { name: "warp", desc: "teleport: rising whoosh with vibrato tail", make: () =>
      cat(sweep(220, 2600, 240, 30, 45),
          [{ freq: 2600, duty: 50, ms: 30 }, { freq: 2200, duty: 50, ms: 30 },
           { freq: 2600, duty: 50, ms: 30 }, { freq: 2000, duty: 50, ms: 40 }]) },
  { name: "explosion", desc: "descending rumble (piezo-faint low end)", make: () =>
      cat(sweep(900, 150, 380, 30, 60), [rest(30), { freq: 160, duty: 70, ms: 120 }]) },

  // --- UI / notification ---
  { name: "success", desc: "rising major arpeggio -> resolve", make: () =>
      notes("C5/90 E5/90 G5/90 C6/240") },
  { name: "notify", desc: "two-tone up chime", make: () =>
      notes("A5/90 E6/260") },
  { name: "chime", desc: "two-tone down chime (softer)", make: () =>
      notes("E6/90 A5/300", 140, 45) },
  { name: "doorbell", desc: "ding-dong", make: () =>
      notes("E5/300 ./40 C5/560") },
  { name: "error", desc: "harsh low descending two-tone", make: () =>
      [{ freq: 233, duty: 55, ms: 200 }, rest(20), { freq: 175, duty: 55, ms: 300 }] },
  { name: "deny", desc: "double low buzz (nope)", make: () =>
      [{ freq: 150, duty: 60, ms: 110 }, rest(60), { freq: 150, duty: 60, ms: 110 }] },
  { name: "tick", desc: "tiny UI click", make: () =>
      [{ freq: 2000, duty: 22, ms: 6 }] },
  { name: "doublebeep", desc: "two clean beeps", make: () =>
      [{ freq: 1568, duty: 50, ms: 60 }, rest(60), { freq: 1568, duty: 50, ms: 60 }] },
  { name: "sonar", desc: "single sonar ping", make: () =>
      [{ freq: 1400, duty: 50, ms: 40 }, { freq: 1350, duty: 30, ms: 120 }] },

  // --- alarms / attention ---
  { name: "alarm", desc: "beep-beep-beep-beep-beep", make: () =>
      rep([{ freq: 1000, duty: 55, ms: 120 }, rest(90)], 5) },
  { name: "siren", desc: "police wail (two-tone x5)", make: () =>
      rep([{ freq: 900, duty: 50, ms: 190 }, { freq: 680, duty: 50, ms: 190 }], 5) },
  { name: "wail", desc: "continuous rise/fall siren", make: () =>
      cat(sweep(500, 1200, 260, 16), sweep(1200, 500, 260, 16),
          sweep(500, 1200, 260, 14)) },
  { name: "heartbeat", desc: "lub-dub x2", make: () =>
      [{ freq: 160, duty: 70, ms: 70 }, rest(40), { freq: 150, duty: 70, ms: 90 },
       rest(320),
       { freq: 160, duty: 70, ms: 70 }, rest(40), { freq: 150, duty: 70, ms: 90 }] },

  // --- character / fun ---
  { name: "sadtrombone", desc: "wah-wah-wah-waaah", make: () =>
      cat(sweep(hz("Bb4"), hz("A4"), 260, 8, 55), [rest(30)],
          sweep(hz("A4"), hz("Ab4"), 260, 8, 55), [rest(30)],
          sweep(hz("Ab4"), hz("G4"), 260, 8, 55), [rest(30)],
          sweep(hz("G4"), hz("Gb4"), 520, 14, 55)) },
  { name: "r2d2", desc: "warbling astromech chatter", make: () =>
      cat(sweep(900, 1900, 90, 8), sweep(1600, 700, 70, 6),
          [rest(30)], sweep(1100, 2200, 80, 7), sweep(2000, 1200, 60, 5),
          [rest(30)], sweep(800, 1500, 70, 6), sweep(1400, 2400, 90, 8)) },
  { name: "questcomplete", desc: "Zelda secret-found jingle", make: () =>
      notes("G5/150 F#5/150 D#5/150 A4/150 G#4/150 E5/150 G#5/150 C6/500") },

  // --- melodies (multi-phrase) ---
  { name: "nokia", desc: "Nokia tune (Gran Vals)", make: () => [
      notes("E6/120 D6/120 F#5/240 G#5/240"),
      notes("C#6/120 B5/120 D5/240 E5/240"),
      notes("B5/120 A5/120 C#5/240 E5/240"),
      notes("A5/480"),
    ] },
  { name: "imperial", desc: "Imperial March opening", make: () => [
      notes("G4/300 G4/300 G4/300 Eb4/210 Bb4/90"),
      notes("G4/300 Eb4/210 Bb4/90 G4/600"),
    ] },
  { name: "mario", desc: "Super Mario Bros. opening bars", make: () => [
      notes("E6/110 E6/110 ./110 E6/110 ./110 C6/110 E6/110"),
      notes("G6/110 ./330 G5/110 ./330"),
      notes("C6/150 ./75 G5/150 ./75 E5/150 ./75"),
      notes("A5/110 B5/110 Bb5/110 A5/150"),
    ] },
  { name: "scale", desc: "C-major run up an octave", make: () =>
      notes("C5/90 D5/90 E5/90 F5/90 G5/90 A5/90 B5/90 C6/180") },
];
