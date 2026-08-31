// Speaker-dot tracking for the Sonic Radar. Dots live in the world frame
// (compass-anchored) so they stay put while the wearer's head turns; the
// people they mark can wander, so each confirmed utterance re-fixes its
// speaker's dot, and while a voice is actively being heard the nearest dot
// glides with the live direction-of-arrival. Pure TypeScript; the session
// engine owns the wall clock and passes `nowMs` in.

export type SpeakerDot = {
  speakerId: number;
  name: string;
  color: string;
  worldAngleDeg: number;
  /** Wall time this speaker was last heard (confirmed or live). */
  lastSpokenMs: number;
  /** True while this speaker's voice is currently being heard. */
  speaking: boolean;
};

/** How long a silent speaker stays on the radar (fading all the while). */
export const SPEAKER_DOT_TTL_MS = 90_000;

/** A confirmed utterance within this arc of a dot refines it; beyond, they moved. */
const SNAP_DEG = 45;
/** Live DOA within this arc of a dot is attributed to that speaker. */
const MATCH_DEG = 30;
/** Smoothing for utterance-confirmed position updates. */
const MOVE_SMOOTHING = 0.5;
/** Smoothing for packet-rate live tracking while they talk (and walk). */
const LIVE_SMOOTHING = 0.25;

const IDLE_BRIGHTNESS_MAX = 220;
const IDLE_BRIGHTNESS_MIN = 80;

/** Wrap to (-180, 180]. */
export function normalizeDeg(deg: number): number {
  let value = deg % 360;
  if (value > 180) value -= 360;
  if (value <= -180) value += 360;
  return value;
}

/** Angle EMA that follows the shorter way around the circle. */
export function smoothAngleDeg(previous: number | null, next: number, alpha: number): number {
  if (previous === null) return normalizeDeg(next);
  const delta = normalizeDeg(next - previous);
  return normalizeDeg(previous + delta * alpha);
}

export type SpeakerIdentity = { speakerId: number; name: string; color: string };

/**
 * A captioned utterance was attributed to a speaker: fix their dot at the
 * utterance's bearing. Small changes smooth (jittery DOA); large ones snap
 * (the person actually moved). Returns the updated dot list.
 */
export function placeDotForUtterance(
  dots: SpeakerDot[],
  who: SpeakerIdentity,
  worldAngleDeg: number,
  nowMs: number,
): SpeakerDot[] {
  const existing = dots.find((dot) => dot.speakerId === who.speakerId);
  if (!existing) {
    return [
      ...dots,
      {
        ...who,
        worldAngleDeg: normalizeDeg(worldAngleDeg),
        lastSpokenMs: nowMs,
        speaking: false,
      },
    ];
  }
  const delta = normalizeDeg(worldAngleDeg - existing.worldAngleDeg);
  existing.worldAngleDeg =
    Math.abs(delta) > SNAP_DEG
      ? normalizeDeg(worldAngleDeg)
      : smoothAngleDeg(existing.worldAngleDeg, worldAngleDeg, MOVE_SMOOTHING);
  existing.name = who.name;
  existing.color = who.color;
  existing.lastSpokenMs = nowMs;
  existing.speaking = false;
  return dots;
}

/**
 * Speech is being heard right now from `worldAngleDeg`: mark the nearest dot
 * within MATCH_DEG as actively speaking and glide it toward the live bearing,
 * so a talker walking around drags their dot with them. Everyone else stops
 * "speaking". Returns whether a dot matched.
 */
export function trackSpeakingDot(dots: SpeakerDot[], worldAngleDeg: number, nowMs: number): boolean {
  let nearest: SpeakerDot | null = null;
  let nearestDelta = Infinity;
  for (const dot of dots) {
    const delta = Math.abs(normalizeDeg(worldAngleDeg - dot.worldAngleDeg));
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearest = dot;
    }
  }
  for (const dot of dots) dot.speaking = false;
  if (!nearest || nearestDelta > MATCH_DEG) return false;
  nearest.speaking = true;
  nearest.lastSpokenMs = nowMs;
  nearest.worldAngleDeg = smoothAngleDeg(nearest.worldAngleDeg, worldAngleDeg, LIVE_SMOOTHING);
  return true;
}

/** No voice is being heard: nobody is actively speaking. */
export function clearSpeaking(dots: SpeakerDot[]): void {
  for (const dot of dots) dot.speaking = false;
}

/** Drop dots whose speakers have been silent past the TTL. */
export function pruneDots(
  dots: SpeakerDot[],
  nowMs: number,
  ttlMs: number = SPEAKER_DOT_TTL_MS,
): SpeakerDot[] {
  return dots.filter((dot) => nowMs - dot.lastSpokenMs < ttlMs);
}

/**
 * Dot brightness: full while actively speaking, then fading with silence age
 * from IDLE_BRIGHTNESS_MAX down to IDLE_BRIGHTNESS_MIN at the TTL.
 */
export function dotBrightness(
  dot: SpeakerDot,
  nowMs: number,
  ttlMs: number = SPEAKER_DOT_TTL_MS,
): number {
  if (dot.speaking) return 255;
  const age = Math.max(0, nowMs - dot.lastSpokenMs);
  const fraction = Math.min(1, age / ttlMs);
  return Math.round(IDLE_BRIGHTNESS_MAX - (IDLE_BRIGHTNESS_MAX - IDLE_BRIGHTNESS_MIN) * fraction);
}
