// A numeric literal that stays exact for as long as it can. Rationals rather
// than floats everywhere is the difference between a step-by-step solution
// that reads `x = 3/2` and one that reads `x = 1.5`, and between
// `1/3 + 1/3 + 1/3 = 1` and `0.9999999999999999`. Anything genuinely
// irrational (a square root, a sine) degrades to `real` and stays there.
//
// Number.isSafeInteger is the overflow guard: an operation whose exact
// result leaves the safe-integer range falls back to a `real` value rather
// than silently losing precision.

export type MathNumber =
  | { kind: "integer"; value: number }
  | { kind: "rational"; n: number; d: number }
  | { kind: "real"; value: number };

export function integer(value: number): MathNumber {
  return { kind: "integer", value };
}

export function real(value: number): MathNumber {
  return { kind: "real", value };
}

/**
 * Always stored normalised: `d > 1`, sign on the numerator, gcd(n, d) === 1.
 * Construct rationals only through here.
 */
export function rational(numerator: number, denominator: number): MathNumber {
  if (denominator === 0) return real(NaN);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    return real(numerator / denominator);
  }
  let n = numerator;
  let d = denominator;
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const divisor = greatestCommonDivisor(Math.abs(n), d);
  if (divisor > 1) {
    n /= divisor;
    d /= divisor;
  }
  return d === 1 ? integer(n) : { kind: "rational", n, d };
}

/**
 * Recover an exact rational from a decimal literal so `0.25` behaves like
 * `1/4` in later arithmetic. Bounded denominator: beyond that the value is
 * almost certainly a measurement rather than a fraction, and pretending
 * otherwise produces absurd numerators. (Stern-Brocot search.)
 */
export function fromDecimal(value: number, maximumDenominator = 1_000_000): MathNumber {
  if (!Number.isFinite(value)) return real(value);
  if (value === Math.round(value) && Number.isSafeInteger(value)) {
    return integer(value);
  }
  let lowerN = 0;
  let lowerD = 1;
  let upperN = 1;
  let upperD = 0;
  const negative = value < 0;
  const target = Math.abs(value);
  for (let iterations = 0; iterations < 64; iterations++) {
    const mediantN = lowerN + upperN;
    const mediantD = lowerD + upperD;
    if (mediantD > maximumDenominator) break;
    const mediant = mediantN / mediantD;
    if (Math.abs(mediant - target) < 1e-12) {
      return rational(negative ? -mediantN : mediantN, mediantD);
    }
    if (mediant < target) {
      lowerN = mediantN;
      lowerD = mediantD;
    } else {
      upperN = mediantN;
      upperD = mediantD;
    }
  }
  return real(value);
}

// ---------------------------------------------------------------------------
// Inspection

export function doubleValue(value: MathNumber): number {
  switch (value.kind) {
    case "integer":
      return value.value;
    case "rational":
      return value.n / value.d;
    case "real":
      return value.value;
  }
}

export function isZero(value: MathNumber): boolean {
  switch (value.kind) {
    case "integer":
      return value.value === 0;
    case "rational":
      return value.n === 0;
    case "real":
      return value.value === 0;
  }
}

export function isOne(value: MathNumber): boolean {
  switch (value.kind) {
    case "integer":
      return value.value === 1;
    case "rational":
      return false; // normalised, so never 1
    case "real":
      return value.value === 1;
  }
}

export function isNegative(value: MathNumber): boolean {
  switch (value.kind) {
    case "integer":
      return value.value < 0;
    case "rational":
      return value.n < 0;
    case "real":
      return value.value < 0;
  }
}

export function isExact(value: MathNumber): boolean {
  return value.kind !== "real";
}

export function isInteger(value: MathNumber): boolean {
  return value.kind === "integer";
}

export function integerValue(value: MathNumber): number | null {
  return value.kind === "integer" ? value.value : null;
}

function asFraction(value: MathNumber): [number, number] | null {
  switch (value.kind) {
    case "integer":
      return [value.value, 1];
    case "rational":
      return [value.n, value.d];
    case "real":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Arithmetic
//
// Exactness is preserved whenever both operands are exact; a single `real`
// anywhere makes the whole result `real`. Overflow falls back to `real`
// rather than trapping — a solver exploring a bad branch must not crash the
// app on the wearer's face.

function safeProducts(...values: number[]): boolean {
  return values.every((value) => Number.isSafeInteger(value));
}

export function add(lhs: MathNumber, rhs: MathNumber): MathNumber {
  const left = asFraction(lhs);
  const right = asFraction(rhs);
  if (!left || !right) return real(doubleValue(lhs) + doubleValue(rhs));
  const [ln, ld] = left;
  const [rn, rd] = right;
  const crossLeft = ln * rd;
  const crossRight = rn * ld;
  const numerator = crossLeft + crossRight;
  const denominator = ld * rd;
  if (!safeProducts(crossLeft, crossRight, numerator, denominator)) {
    return real(doubleValue(lhs) + doubleValue(rhs));
  }
  return rational(numerator, denominator);
}

export function subtract(lhs: MathNumber, rhs: MathNumber): MathNumber {
  return add(lhs, negated(rhs));
}

export function multiply(lhs: MathNumber, rhs: MathNumber): MathNumber {
  const left = asFraction(lhs);
  const right = asFraction(rhs);
  if (!left || !right) return real(doubleValue(lhs) * doubleValue(rhs));
  const [ln, ld] = left;
  const [rn, rd] = right;
  const numerator = ln * rn;
  const denominator = ld * rd;
  if (!safeProducts(numerator, denominator)) {
    return real(doubleValue(lhs) * doubleValue(rhs));
  }
  return rational(numerator, denominator);
}

export function divide(lhs: MathNumber, rhs: MathNumber): MathNumber {
  if (isZero(rhs)) return real(doubleValue(lhs) / doubleValue(rhs));
  const left = asFraction(lhs);
  const right = asFraction(rhs);
  if (!left || !right) return real(doubleValue(lhs) / doubleValue(rhs));
  const [ln, ld] = left;
  const [rn, rd] = right;
  const numerator = ln * rd;
  const denominator = ld * rn;
  if (!safeProducts(numerator, denominator)) {
    return real(doubleValue(lhs) / doubleValue(rhs));
  }
  return rational(numerator, denominator);
}

export function negated(value: MathNumber): MathNumber {
  switch (value.kind) {
    case "integer":
      return integer(-value.value);
    case "rational":
      return { kind: "rational", n: -value.n, d: value.d };
    case "real":
      return real(-value.value);
  }
}

export function reciprocal(value: MathNumber): MathNumber {
  switch (value.kind) {
    case "integer":
      return rational(1, value.value);
    case "rational":
      return rational(value.d, value.n);
    case "real":
      return real(1 / value.value);
  }
}

/**
 * Exact only when the result stays rational — an integer exponent, or a
 * perfect root. `2^0.5` is irrational, so it becomes `real`.
 */
export function raisedTo(base: MathNumber, exponent: MathNumber): MathNumber {
  const fraction = asFraction(base);
  const power = integerValue(exponent);
  if (power !== null && fraction) {
    const [n, d] = fraction;
    if (power >= 0 && power < 64) {
      let numerator = 1;
      let denominator = 1;
      let overflow = false;
      for (let step = 0; step < power; step++) {
        numerator *= n;
        denominator *= d;
        if (!safeProducts(numerator, denominator)) {
          overflow = true;
          break;
        }
      }
      if (!overflow) return rational(numerator, denominator);
    } else if (power < 0 && power > -64 && !isZero(base)) {
      return raisedTo(reciprocal(base), integer(-power));
    }
  }
  // An exact root of a perfect power stays exact: sqrt(9/4) = 3/2.
  if (exponent.kind === "rational" && exponent.d === 2 && exponent.n === 1 && fraction) {
    const [n, d] = fraction;
    if (n >= 0) {
      const rootN = Math.round(Math.sqrt(n));
      const rootD = Math.round(Math.sqrt(d));
      if (rootN * rootN === n && rootD * rootD === d) return rational(rootN, rootD);
    }
  }
  return real(Math.pow(doubleValue(base), doubleValue(exponent)));
}

export function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x === 0 ? 1 : x;
}

// ---------------------------------------------------------------------------
// Comparison

export function lessThan(lhs: MathNumber, rhs: MathNumber): boolean {
  return doubleValue(lhs) < doubleValue(rhs);
}

/**
 * Structural equality would make `integer(1)` differ from `real(1)`, which
 * breaks simplification against numbers that came back from a numeric path.
 * Compare by value instead, with a tolerance for reals.
 */
export function numberEquals(lhs: MathNumber, rhs: MathNumber): boolean {
  const left = asFraction(lhs);
  const right = asFraction(rhs);
  if (left && right) return left[0] === right[0] && left[1] === right[1];
  const a = doubleValue(lhs);
  const b = doubleValue(rhs);
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= 1e-12 * scale;
}

// ---------------------------------------------------------------------------
// Display

/** Plain-text form for the glasses and for spoken readback. */
export function describeNumber(value: MathNumber): string {
  switch (value.kind) {
    case "integer":
      return String(value.value);
    case "rational":
      return `${value.n}/${value.d}`;
    case "real": {
      const raw = value.value;
      if (Number.isNaN(raw)) return "NaN";
      if (raw === Math.round(raw) && Math.abs(raw) < 1e15) {
        return String(Math.round(raw));
      }
      // Trim to something a person can read aloud, without exponent notation
      // for ordinary magnitudes.
      if (Math.abs(raw) >= 1e-4 && Math.abs(raw) < 1e9) {
        let text = raw.toFixed(6);
        while (text.endsWith("0")) text = text.slice(0, -1);
        if (text.endsWith(".")) text = text.slice(0, -1);
        return text;
      }
      return formatG(raw);
    }
  }
}

/** Approximates C's %g: shortest of decimal/exponent form at 6 significant digits. */
function formatG(value: number): string {
  if (value === 0) return "0";
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent >= -4 && exponent < 6) {
    const text = value.toPrecision(6);
    return trimTrailingZeros(text);
  }
  const mantissa = trimTrailingZeros((value / Math.pow(10, exponent)).toPrecision(6));
  const sign = exponent >= 0 ? "+" : "-";
  const padded = String(Math.abs(exponent)).padStart(2, "0");
  return `${mantissa}e${sign}${padded}`;
}

function trimTrailingZeros(text: string): string {
  if (!text.includes(".")) return text;
  let result = text;
  while (result.endsWith("0")) result = result.slice(0, -1);
  if (result.endsWith(".")) result = result.slice(0, -1);
  return result;
}

/** Thousands-separated integer. */
export function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
