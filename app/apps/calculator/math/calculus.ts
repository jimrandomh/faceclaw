// Limits, Taylor series, and curve analysis.

import {
  type MathExpression,
  addExpr,
  divideExpr,
  multiplyExpr,
  num,
  numberValue,
  powerExpr,
  subtractExpr,
  variable as variableExpr,
  ONE,
  ZERO,
} from "./expression";
import { describeNumber, divide as divideNumber, fromDecimal, integer, isNegative, isOne, negated } from "./math-number";
import { evaluateValue } from "./evaluator";
import { differentiate } from "./derivative";
import { simplify } from "./simplifier";
import { Polynomial } from "./polynomial";
import { numericRoots as polynomialNumericRoots } from "./solver";

// ---------------------------------------------------------------------------
// Limits

export type LimitApproach = "both" | "fromLeft" | "fromRight";

export type LimitResult =
  | { kind: "value"; value: number }
  | { kind: "positiveInfinity" }
  | { kind: "negativeInfinity" }
  /** One-sided limits disagree, so the two-sided limit does not exist. */
  | { kind: "doesNotExist"; left: number | null; right: number | null }
  | { kind: "indeterminate" };

export function limitText(result: LimitResult): string {
  switch (result.kind) {
    case "value":
      return describeNumber(fromDecimal(result.value));
    case "positiveInfinity":
      return "+∞";
    case "negativeInfinity":
      return "−∞";
    case "doesNotExist":
      return "does not exist";
    case "indeterminate":
      return "indeterminate";
  }
}

/**
 * Limit of `expression` as `variable` → `point`.
 *
 * Direct substitution first, then L'Hôpital for 0/0 and ∞/∞, then a numeric
 * squeeze. The order matters: substitution is exact when it works, L'Hôpital
 * is exact when it applies, and only the leftovers get the approximate
 * treatment.
 */
export function limit(
  expression: MathExpression,
  variable: string,
  point: number,
  approach: LimitApproach = "both",
): LimitResult {
  if (approach === "both" && Number.isFinite(point)) {
    const direct = evaluateValue(expression, { [variable]: point });
    if (direct !== null && Number.isFinite(direct)) {
      return { kind: "value", value: direct };
    }
  }
  const hospital = lHopital(expression, variable, point, 0);
  if (hospital) return hospital;
  return numericLimit(expression, variable, point, approach);
}

/** Detect an indeterminate quotient and differentiate top and bottom. */
function lHopital(
  expression: MathExpression,
  variable: string,
  point: number,
  depth: number,
): LimitResult | null {
  // Bounded: a quotient that stays indeterminate forever (sin(1/x)/x) must
  // give up rather than recurse without end.
  if (depth >= 8 || !Number.isFinite(point)) return null;
  const quotient = asQuotient(expression);
  if (!quotient) return null;
  const [numerator, denominator] = quotient;

  const top = evaluateValue(numerator, { [variable]: point });
  const bottom = evaluateValue(denominator, { [variable]: point });
  if (top === null || bottom === null) return null;

  const isZeroOverZero = Math.abs(top) < 1e-12 && Math.abs(bottom) < 1e-12;
  const isInfinityOverInfinity = !Number.isFinite(top) && !Number.isFinite(bottom);
  if (!isZeroOverZero && !isInfinityOverInfinity) return null;

  const dTop = differentiate(numerator, variable);
  const dBottom = differentiate(denominator, variable);
  // A vanishing derivative of the denominator means the rule does not apply
  // again; fall through to the numeric path.
  const bottomValue = evaluateValue(dBottom, { [variable]: point });
  if (bottomValue === null || !Number.isFinite(bottomValue)) return null;

  if (Math.abs(bottomValue) > 1e-12) {
    const topValue = evaluateValue(dTop, { [variable]: point });
    if (topValue !== null && Number.isFinite(topValue)) {
      return { kind: "value", value: topValue / bottomValue };
    }
  }
  return lHopital(divideExpr(dTop, dBottom), variable, point, depth + 1);
}

/** Recognise `a / b`, which the tree stores as `a · b^-1`. */
export function asQuotient(expression: MathExpression): [MathExpression, MathExpression] | null {
  if (expression.type !== "multiply") return null;
  const numerator: MathExpression[] = [];
  const denominator: MathExpression[] = [];
  for (const factor of expression.factors) {
    if (factor.type === "power") {
      const power = numberValue(factor.exponent);
      if (power && isNegative(power)) {
        const positive = negated(power);
        denominator.push(isOne(positive) ? factor.base : powerExpr(factor.base, num(positive)));
        continue;
      }
    }
    numerator.push(factor);
  }
  if (denominator.length === 0) return null;
  return [
    numerator.length === 0 ? ONE : numerator.length === 1 ? numerator[0]! : multiplyExpr(numerator),
    denominator.length === 1 ? denominator[0]! : multiplyExpr(denominator),
  ];
}

function numericLimit(
  expression: MathExpression,
  variable: string,
  point: number,
  approach: LimitApproach,
): LimitResult {
  const sampleSide = (side: LimitApproach): number | null => {
    if (!Number.isFinite(point)) {
      // At infinity, march outward instead of shrinking a step.
      const sign = point > 0 ? 1 : -1;
      let last: number | null = null;
      for (const magnitude of [1e3, 1e4, 1e5, 1e6, 1e7]) {
        const value = evaluateValue(expression, { [variable]: sign * magnitude });
        if (value === null || !Number.isFinite(value)) return last;
        last = value;
      }
      return last;
    }
    const samples: number[] = [];
    for (const step of [1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7]) {
      const offset = side === "fromLeft" ? -step : step;
      const value = evaluateValue(expression, { [variable]: point + offset });
      if (value === null || !Number.isFinite(value)) continue;
      samples.push(value);
    }
    const last = samples[samples.length - 1];
    if (last === undefined) return null;
    // Divergence is a TREND, not a threshold. 1/x reaches only 1e7 at the
    // smallest step sampled here, so a fixed "> 1e12" cutoff calls it finite;
    // magnitudes growing by an order per step do not.
    if (samples.length >= 3) {
      const tail = samples.slice(-3);
      const magnitudes = tail.map((value) => Math.abs(value));
      const growing = magnitudes.every(
        (value, index) => index === 0 || value > magnitudes[index - 1]! * 5,
      );
      if (growing && (magnitudes[magnitudes.length - 1] ?? 0) > 1e4) {
        return last > 0 ? Infinity : -Infinity;
      }
    }
    return last;
  };

  switch (approach) {
    case "fromLeft": {
      const value = sampleSide("fromLeft");
      return value === null ? { kind: "indeterminate" } : classify(value);
    }
    case "fromRight": {
      const value = sampleSide("fromRight");
      return value === null ? { kind: "indeterminate" } : classify(value);
    }
    case "both": {
      const left = sampleSide("fromLeft");
      const right = sampleSide("fromRight");
      if (left === null || right === null) return { kind: "indeterminate" };
      // Scale-relative comparison: two values near 1e6 differing by 1 are the
      // same limit; two near 0 differing by 1 are not.
      const scale = Math.max(Math.abs(left), Math.abs(right), 1);
      if (Math.abs(left - right) >= 1e-4 * scale) {
        return { kind: "doesNotExist", left, right };
      }
      return classify((left + right) / 2);
    }
  }
}

function classify(value: number): LimitResult {
  if (!Number.isFinite(value)) {
    return value > 0 ? { kind: "positiveInfinity" } : { kind: "negativeInfinity" };
  }
  if (value > 1e12) return { kind: "positiveInfinity" };
  if (value < -1e12) return { kind: "negativeInfinity" };
  return { kind: "value", value };
}

// ---------------------------------------------------------------------------
// Series

/** Taylor expansion about `centre`, to `order` terms. */
export function taylor(
  expression: MathExpression,
  variable: string,
  order = 5,
  centre = 0,
): MathExpression | null {
  if (order < 0 || order > 12) return null;
  const terms: MathExpression[] = [];
  let derivative = expression;
  let factorial = 1;

  for (let degree = 0; degree <= order; degree++) {
    if (degree > 0) {
      derivative = differentiate(derivative, variable);
      factorial *= degree;
    }
    const coefficient = evaluateValue(derivative, { [variable]: centre });
    if (coefficient === null || !Number.isFinite(coefficient)) return null;
    if (Math.abs(coefficient) <= 1e-12) continue;

    const scaled = divideNumber(fromDecimal(coefficient), integer(factorial));
    const shifted: MathExpression =
      centre === 0
        ? variableExpr(variable)
        : subtractExpr(variableExpr(variable), num(fromDecimal(centre)));
    const power: MathExpression =
      degree === 0 ? ONE : degree === 1 ? shifted : powerExpr(shifted, num(integer(degree)));
    terms.push(degree === 0 ? num(scaled) : multiplyExpr([num(scaled), power]));
  }
  if (terms.length === 0) return ZERO;
  return simplify(addExpr(terms));
}

// ---------------------------------------------------------------------------
// Curve analysis

export type CriticalPointKind = "minimum" | "maximum" | "inflection" | "undetermined";

export type CriticalPoint = {
  x: number;
  y: number;
  kind: CriticalPointKind;
};

export function criticalPointText(point: CriticalPoint): string {
  const xText = describeNumber(fromDecimal(point.x));
  const yText = describeNumber(fromDecimal(point.y));
  return `${point.kind} at (${xText}, ${yText})`;
}

/**
 * Critical points classified by the second derivative, falling back to a
 * sign test where the second derivative vanishes.
 */
export function criticalPoints(
  expression: MathExpression,
  variable: string,
  range: [number, number] = [-50, 50],
): CriticalPoint[] {
  const first = differentiate(expression, variable);
  const second = differentiate(first, variable);

  let roots: number[];
  const polynomial = Polynomial.extract(first, variable);
  if (polynomial) {
    roots = polynomialNumericRoots(polynomial, range, 20_000);
  } else {
    roots = numericRootsOfExpression(first, variable, range);
  }

  const points: CriticalPoint[] = [];
  for (const x of roots) {
    const y = evaluateValue(expression, { [variable]: x });
    if (y === null || !Number.isFinite(y)) continue;
    const curvature = evaluateValue(second, { [variable]: x }) ?? 0;
    let kind: CriticalPointKind;
    if (curvature > 1e-9) {
      kind = "minimum";
    } else if (curvature < -1e-9) {
      kind = "maximum";
    } else {
      // Second-derivative test is inconclusive; look at how the first
      // derivative behaves either side.
      const left = evaluateValue(first, { [variable]: x - 1e-4 }) ?? 0;
      const right = evaluateValue(first, { [variable]: x + 1e-4 }) ?? 0;
      if (left < 0 && right > 0) kind = "minimum";
      else if (left > 0 && right < 0) kind = "maximum";
      else kind = "inflection";
    }
    points.push({ x, y, kind });
  }
  return points;
}

export function numericRootsOfExpression(
  expression: MathExpression,
  variable: string,
  range: [number, number],
  samples = 20_000,
): number[] {
  const [lower, upper] = range;
  const roots: number[] = [];
  const step = (upper - lower) / samples;
  let previousX = lower;
  let previousY = evaluateValue(expression, { [variable]: previousX });

  for (let index = 1; index <= samples; index++) {
    const x = lower + index * step;
    const y = evaluateValue(expression, { [variable]: x });
    const lastX = previousX;
    const lastY = previousY;
    previousX = x;
    previousY = y;
    if (y === null || lastY === null) continue;
    if (Math.sign(lastY) === Math.sign(y)) continue;
    if (Math.abs(y) >= 1e6 || Math.abs(lastY) >= 1e6) continue;

    let low = lastX;
    let high = x;
    for (let iteration = 0; iteration < 60; iteration++) {
      const mid = (low + high) / 2;
      const value = evaluateValue(expression, { [variable]: mid });
      const lowValue = evaluateValue(expression, { [variable]: low });
      if (value === null || lowValue === null) break;
      if (value === 0) {
        low = mid;
        high = mid;
        break;
      }
      if (Math.sign(value) === Math.sign(lowValue)) {
        low = mid;
      } else {
        high = mid;
      }
    }
    const root = (low + high) / 2;
    // Same pole guard as the main solver: verify the residual.
    const residual = evaluateValue(expression, { [variable]: root });
    if (residual === null || Math.abs(residual) >= 1e-6) continue;
    if (!roots.some((existing) => Math.abs(existing - root) < 1e-6)) roots.push(root);
  }
  return roots;
}
