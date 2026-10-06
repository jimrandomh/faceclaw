/**
 * Speeds offered by the Settings > Customization > Animations settings.
 * Animation durations are tuned at Normal; the other speeds play them faster
 * or slower, and Disabled makes them instant.
 */
export const ANIMATION_SPEEDS = ["disabled", "very-fast", "fast", "normal", "slow"] as const;
export type AnimationSpeed = typeof ANIMATION_SPEEDS[number];

const SPEED_FACTORS: Record<AnimationSpeed, number> = { disabled: 0, "very-fast": 5, fast: 2, normal: 1, slow: 0.5 };
const SPEED_LABELS: Record<AnimationSpeed, string> = {
  disabled: "Disabled", "very-fast": "Very Fast", fast: "Fast", normal: "Normal", slow: "Slow",
};

export function animationSpeedLabel(speed: AnimationSpeed): string {
  return SPEED_LABELS[speed];
}

export function normalizeAnimationSpeed(value: string | null | undefined): AnimationSpeed {
  return ANIMATION_SPEEDS.includes(value as AnimationSpeed) ? value as AnimationSpeed : "normal";
}

/** A duration tuned for Normal speed, played at `speed`: whole milliseconds, or 0 when disabled. */
export function scaleAnimationDuration(normalMs: number, speed: AnimationSpeed): number {
  const factor = SPEED_FACTORS[speed];
  return factor ? Math.max(1, Math.round(normalMs / factor)) : 0;
}
