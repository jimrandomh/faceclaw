// Trig equation solving and the identity sheet. The distinguishing feature
// versus the generic numeric root finder: a trig equation has infinitely many
// solutions, and the right answer is the FAMILY (`x = π/6 + 2πn`), not the
// twelve roots that happen to fall in the search window. Reporting a finite
// list for `sin x = 1/2` is the standard wrong answer in this topic.

import {
  type MathExpression,
  ZERO,
  constant,
  divideExpr,
  int,
  multiplyExpr,
} from "./expression";
import { describeNumber, fromDecimal } from "./math-number";
import { plain } from "./text-renderer";

// ---------------------------------------------------------------------------
// Solutions

/** One family of solutions: `base + period·n`. */
export type SolutionFamily = {
  base: number;
  period: number;
  /** Exact form when the base is a recognisable multiple of π. */
  baseExpression: MathExpression | null;
};

export function familyValues(family: SolutionFamily, lower: number, upper: number): number[] {
  if (family.period <= 0) {
    return family.base >= lower && family.base <= upper ? [family.base] : [];
  }
  const results: number[] = [];
  let n = Math.floor((lower - family.base) / family.period);
  for (;;) {
    const value = family.base + n * family.period;
    if (value > upper) break;
    if (value >= lower) results.push(value);
    n += 1;
    if (results.length > 1000) break;
  }
  return results;
}

export function familyText(family: SolutionFamily): string {
  const baseText = family.baseExpression
    ? plain(family.baseExpression)
    : describeNumber(fromDecimal(family.base));
  // The separator is load-bearing: "2*pi" run straight into the index reads
  // as "2*pin", a different and nonsensical expression to anyone scanning it
  // on the lens.
  const periodText = describePi(family.period);
  return `${baseText} + ${periodText}·n`;
}

export type SolutionSet =
  | { kind: "families"; families: SolutionFamily[] }
  | { kind: "all" }
  | { kind: "none" };

/** Solve `f(x) = value` for sin, cos, or tan. */
export function solveTrig(functionName: "sin" | "cos" | "tan", value: number): SolutionSet {
  switch (functionName) {
    case "sin": {
      if (Math.abs(value) > 1) return { kind: "none" };
      const principal = Math.asin(value);
      // sin has two families per period, which collapse to one when the value
      // is ±1 (the turning points).
      if (Math.abs(Math.abs(value) - 1) < 1e-12) {
        return { kind: "families", families: [family(principal, 2 * Math.PI)] };
      }
      return {
        kind: "families",
        families: [family(principal, 2 * Math.PI), family(Math.PI - principal, 2 * Math.PI)],
      };
    }

    case "cos": {
      if (Math.abs(value) > 1) return { kind: "none" };
      const principal = Math.acos(value);
      if (Math.abs(principal) < 1e-12 || Math.abs(principal - Math.PI) < 1e-12) {
        return { kind: "families", families: [family(principal, 2 * Math.PI)] };
      }
      return {
        kind: "families",
        families: [family(principal, 2 * Math.PI), family(-principal, 2 * Math.PI)],
      };
    }

    case "tan":
      // tan repeats every π, not 2π — one family covers everything.
      return { kind: "families", families: [family(Math.atan(value), Math.PI)] };
  }
}

function family(base: number, period: number): SolutionFamily {
  return { base, period, baseExpression: piMultiple(base) };
}

/**
 * Recognise a value as an exact rational multiple of π, so a solution reads
 * `π/6` instead of `0.5235987755982988`.
 */
export function piMultiple(value: number): MathExpression | null {
  if (!Number.isFinite(value)) return null;
  if (Math.abs(value) < 1e-12) return ZERO;
  const ratio = value / Math.PI;
  for (const denominator of [1, 2, 3, 4, 6, 8, 12]) {
    const scaled = ratio * denominator;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) >= 1e-9 || Math.abs(rounded) >= 1e6) continue;
    const numerator = rounded;
    if (numerator === 0) return ZERO;
    if (numerator === 1 && denominator === 1) return constant("pi");
    // pi/6, not (1/6)*pi — a unit numerator belongs in the fraction, which is
    // how every textbook writes these solution families.
    if (numerator === 1) return divideExpr(constant("pi"), int(denominator));
    if (denominator === 1) return multiplyExpr([int(numerator), constant("pi")]);
    return divideExpr(multiplyExpr([int(numerator), constant("pi")]), int(denominator));
  }
  return null;
}

function describePi(value: number): string {
  const multiple = piMultiple(value);
  return multiple ? plain(multiple) : describeNumber(fromDecimal(value));
}

// ---------------------------------------------------------------------------
// Identities

export type TrigIdentity = {
  name: string;
  plain: string;
};

/**
 * The identity sheet, for the "explain it" surface and for a wearer who
 * wants the reference on the lens.
 */
export const TRIG_IDENTITIES: readonly TrigIdentity[] = [
  { name: "Pythagorean", plain: "sin²θ + cos²θ = 1" },
  { name: "Pythagorean (tan)", plain: "1 + tan²θ = sec²θ" },
  { name: "Sine sum", plain: "sin(a ± b) = sin a cos b ± cos a sin b" },
  { name: "Cosine sum", plain: "cos(a ± b) = cos a cos b ∓ sin a sin b" },
  { name: "Tangent sum", plain: "tan(a ± b) = (tan a ± tan b) / (1 ∓ tan a tan b)" },
  { name: "Double angle (sine)", plain: "sin 2θ = 2 sin θ cos θ" },
  { name: "Double angle (cosine)", plain: "cos 2θ = cos²θ − sin²θ = 2cos²θ − 1" },
  { name: "Half angle", plain: "sin²θ = (1 − cos 2θ)/2" },
  { name: "Law of sines", plain: "a/sin A = b/sin B = c/sin C" },
  { name: "Law of cosines", plain: "c² = a² + b² − 2ab cos C" },
];

export function identityMatching(query: string): TrigIdentity | null {
  const needle = query.toLowerCase();
  return (
    TRIG_IDENTITIES.find((identity) => identity.name.toLowerCase().includes(needle)) ??
    TRIG_IDENTITIES.find((identity) => needle.includes(identity.name.toLowerCase())) ??
    null
  );
}

// ---------------------------------------------------------------------------
// Conversion

export function degreesFromRadians(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function radiansFromDegrees(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
