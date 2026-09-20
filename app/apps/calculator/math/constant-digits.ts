// Digit expansions of the well-known constants, computed exactly. Computed
// rather than tabulated: a hardcoded string of π is a thing nobody can check,
// and a single transposed digit would silently shift every position this
// feature reports. Everything here comes out of integer arithmetic that can
// be re-derived and tested.
//
// JavaScript's native BigInt supplies the operation set the generators need
// (add, subtract, compare, multiply/divide by a small scalar).
// The deep paths are async and yield to the event loop periodically — a
// multi-minute synchronous grind would freeze the app's whole UI thread.

export type MathConstantName = "pi" | "e" | "phi" | "sqrt2" | "sqrt3" | "sqrt5";

export const ALL_CONSTANT_NAMES: readonly MathConstantName[] = ["pi", "e", "phi", "sqrt2", "sqrt3", "sqrt5"];

export function constantDisplayName(constant: MathConstantName): string {
  switch (constant) {
    case "pi":
      return "π";
    case "e":
      return "e";
    case "phi":
      return "φ";
    case "sqrt2":
      return "√2";
    case "sqrt3":
      return "√3";
    case "sqrt5":
      return "√5";
  }
}

export function constantSpokenName(constant: MathConstantName): string {
  switch (constant) {
    case "pi":
      return "pi";
    case "e":
      return "e";
    case "phi":
      return "the golden ratio";
    case "sqrt2":
      return "the square root of 2";
    case "sqrt3":
      return "the square root of 3";
    case "sqrt5":
      return "the square root of 5";
  }
}

/** Digits before the decimal point — 1 for all of these. */
export const CONSTANT_INTEGER_PART_DIGITS = 1;

export function constantNamed(text: string): MathConstantName | null {
  const lowered = text.toLowerCase();
  if (lowered.includes("golden") || lowered.includes("phi")) return "phi";
  if (lowered.includes("root of 2") || lowered.includes("root two") || lowered.includes("sqrt2")) {
    return "sqrt2";
  }
  if (lowered.includes("root of 3") || lowered.includes("root three")) return "sqrt3";
  if (lowered.includes("root of 5") || lowered.includes("root five")) return "sqrt5";
  // Word-boundary matched, not substring: `includes("pi")` also fires on
  // "pie", "spin", and "copying", and `=== "e"` only ever matched a
  // single-character utterance, so "the digits of e" never resolved.
  if (lowered.includes("π") || hasWord("pi", lowered)) return "pi";
  if (hasWord("e", lowered) || lowered.includes("euler")) return "e";
  return null;
}

function hasWord(word: string, text: string): boolean {
  return new RegExp(`\\b${word}\\b`).test(text);
}

// ---------------------------------------------------------------------------
// Cancellation and progress

/** Cooperative cancellation for the long paths. */
export type ComputeCancellation = () => boolean;

export const NEVER_CANCELLED: ComputeCancellation = () => false;

/** Raised when a long run is cancelled partway. */
export class ComputeCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "ComputeCancelled";
  }
}

export type ComputeProgress = (fraction: number, stage: string) => void;

// setTimeout via globalThis so this module needs no platform lib: it runs
// under NativeScript's globals in the app and under Node in the tests.
const scheduleMacrotask: (callback: () => void) => void = (callback) =>
  (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => unknown }).setTimeout(callback, 0);

/**
 * Yield to the event loop when the current slice has run long enough. The
 * generators call this between series terms so a deep run stays cancellable
 * and the rest of the app keeps painting.
 */
class Yielder {
  private lastYieldAt = Date.now();

  async maybeYield(): Promise<void> {
    if (Date.now() - this.lastYieldAt < 50) return;
    await new Promise<void>((resolve) => scheduleMacrotask(resolve));
    this.lastYieldAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Limits

/**
 * How far the on-device generator will go for an ordinary question.
 *
 * Machin's formula is O(n²) in the digit count with scalar-only big
 * arithmetic. 10,000 digits is well under a second and finds any two- or
 * three-digit run plus most four-digit ones; past this, the wearer opts into
 * a long run explicitly.
 */
export const MAXIMUM_COMPUTED_DIGITS = 10_000;

/**
 * The furthest an opted-in long run will go, however much time the wearer
 * offers. Not a time limit — the caller has already accepted the wait — but
 * a memory-and-honesty one: the O(n²) cost puts this at hours on a phone,
 * past which nobody is still waiting.
 */
export const MAXIMUM_FEASIBLE_DIGITS = 2_000_000;

// ---------------------------------------------------------------------------
// Cache

/**
 * The same constant is asked for repeatedly within one session (search, then
 * context, then a second search), and recomputing 10,000 digits each time
 * would be pointlessly slow. Grow-only.
 */
const cache = new Map<MathConstantName, string>();

function cachedDigits(constant: MathConstantName, atLeast: number): string | null {
  const cached = cache.get(constant);
  if (!cached || cached.length < atLeast) return null;
  return cached;
}

function storeDigits(constant: MathConstantName, digits: string): void {
  const existing = cache.get(constant);
  if (existing && existing.length >= digits.length) return;
  cache.set(constant, digits);
}

// ---------------------------------------------------------------------------
// Public entry points

/**
 * Fractional digits only — the part after the decimal point, which is what
 * "position N of π" universally means. Clamped to MAXIMUM_COMPUTED_DIGITS;
 * the deeper run is a separate call the wearer has to opt into, so no
 * ordinary caller can accidentally block the app for minutes.
 */
export function fractionalDigits(constant: MathConstantName, count: number): string | null {
  const requested = Math.min(Math.max(count, 1), MAXIMUM_COMPUTED_DIGITS);
  const cached = cachedDigits(constant, requested);
  if (cached) return cached.slice(0, requested);
  // The shallow path runs synchronously; at 10k digits it is fast enough that
  // an async hop would only complicate every caller.
  const digits = computeSync(constant, requested);
  if (digits === null) return null;
  storeDigits(constant, digits);
  return digits.slice(0, requested);
}

/**
 * The opted-in deep run. Cancellable, and reports progress, because a
 * multi-minute grind with no way out and nothing on screen is
 * indistinguishable from a hang.
 */
export async function deepFractionalDigits(
  constant: MathConstantName,
  count: number,
  cancellation: ComputeCancellation = NEVER_CANCELLED,
  progress: ComputeProgress | null = null,
): Promise<string | null> {
  const requested = Math.min(Math.max(count, 1), MAXIMUM_FEASIBLE_DIGITS);
  const cached = cachedDigits(constant, requested);
  if (cached) return cached.slice(0, requested);
  const digits = await compute(constant, requested, cancellation, progress, new Yielder());
  if (digits === null) return null;
  storeDigits(constant, digits);
  return digits.slice(0, requested);
}

function computeSync(constant: MathConstantName, requested: number): string | null {
  // A resolved-synchronously wrapper would still be async; instead run the
  // shared generator with a yielder that never fires (50ms slices cannot
  // elapse mid-loop when the whole computation is sub-second) by executing
  // the promise eagerly. The generators only await through Yielder.maybeYield,
  // which resolves immediately below the time threshold, so the promise
  // settles synchronously enough — but rather than rely on that, the shallow
  // path uses the dedicated synchronous variants.
  return computeCore(constant, requested, NEVER_CANCELLED, null, null);
}

async function compute(
  constant: MathConstantName,
  requested: number,
  cancellation: ComputeCancellation,
  progress: ComputeProgress | null,
  yielder: Yielder,
): Promise<string | null> {
  return computeCoreAsync(constant, requested, cancellation, progress, yielder);
}

// ---------------------------------------------------------------------------
// Core generators
//
// Each exists in a synchronous and an asynchronous variant sharing the same
// arithmetic. The async ones interleave event-loop yields; the sync ones are
// used only under MAXIMUM_COMPUTED_DIGITS where the total cost is small.

/**
 * Guard digits absorb the truncation error the series accumulates in its
 * least significant places; without them the last handful of reported digits
 * are wrong, which for a position-reporting feature is the whole ballgame.
 */
const GUARD_DIGITS = 20;

function computeCore(
  constant: MathConstantName,
  requested: number,
  cancellation: ComputeCancellation,
  progress: ComputeProgress | null,
  _yielder: null,
): string | null {
  const scale = requested + GUARD_DIGITS;
  let scaled: bigint;
  switch (constant) {
    case "pi":
      scaled = machinPiSync(scale, cancellation, progress);
      break;
    case "e":
      scaled = eulerESync(scale, cancellation, progress);
      break;
    case "phi": {
      // φ = (1 + √5) / 2
      const root = integerSquareRootSync(5, scale, cancellation, progress);
      scaled = (root + powerOfTen(scale)) / 2n;
      break;
    }
    case "sqrt2":
      scaled = integerSquareRootSync(2, scale, cancellation, progress);
      break;
    case "sqrt3":
      scaled = integerSquareRootSync(3, scale, cancellation, progress);
      break;
    case "sqrt5":
      scaled = integerSquareRootSync(5, scale, cancellation, progress);
      break;
  }
  return finishDigits(scaled, requested);
}

async function computeCoreAsync(
  constant: MathConstantName,
  requested: number,
  cancellation: ComputeCancellation,
  progress: ComputeProgress | null,
  yielder: Yielder,
): Promise<string | null> {
  const scale = requested + GUARD_DIGITS;
  let scaled: bigint;
  switch (constant) {
    case "pi":
      scaled = await machinPi(scale, cancellation, progress, yielder);
      break;
    case "e":
      scaled = await eulerE(scale, cancellation, progress, yielder);
      break;
    case "phi": {
      const root = await integerSquareRoot(5, scale, cancellation, progress, yielder);
      scaled = (root + powerOfTen(scale)) / 2n;
      break;
    }
    case "sqrt2":
      scaled = await integerSquareRoot(2, scale, cancellation, progress, yielder);
      break;
    case "sqrt3":
      scaled = await integerSquareRoot(3, scale, cancellation, progress, yielder);
      break;
    case "sqrt5":
      scaled = await integerSquareRoot(5, scale, cancellation, progress, yielder);
      break;
  }
  return finishDigits(scaled, requested);
}

/**
 * The value is the constant × 10^scale. Strip the integer part, then the
 * guard digits.
 */
function finishDigits(scaled: bigint, requested: number): string | null {
  const text = scaled.toString();
  if (text.length <= CONSTANT_INTEGER_PART_DIGITS) return null;
  const fractional = text.slice(CONSTANT_INTEGER_PART_DIGITS);
  if (fractional.length < requested) return null;
  const trimmed = fractional.slice(0, fractional.length - GUARD_DIGITS);
  return trimmed.slice(0, requested);
}

export function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(Math.max(0, exponent));
}

// ---------------------------------------------------------------------------
// π — Machin's formula: π = 16·arctan(1/5) − 4·arctan(1/239).
//
// Chosen over Chudnovsky because it needs only scalar big-integer operations
// — no big×big multiply, no big÷big division, no square roots of big values.

// arctan(1/5) needs log10(239)/log10(5) ≈ 3.4× as many terms as arctan(1/239)
// at the same scale, and each term costs the same, so the first phase is
// ~77% of the work. Splitting the reported fraction that way keeps the
// progress bar honest instead of stalling at half.
const MACHIN_FIRST_SHARE = 0.77;

function machinPiSync(
  scale: number,
  cancellation: ComputeCancellation,
  progress: ComputeProgress | null,
): bigint {
  const first =
    arctanReciprocalSync(5, scale, cancellation, (fraction) =>
      progress?.(fraction * MACHIN_FIRST_SHARE, "π series 1 of 2"),
    ) * 16n;
  const second =
    arctanReciprocalSync(239, scale, cancellation, (fraction) =>
      progress?.(MACHIN_FIRST_SHARE + fraction * (1 - MACHIN_FIRST_SHARE), "π series 2 of 2"),
    ) * 4n;
  return first - second;
}

async function machinPi(
  scale: number,
  cancellation: ComputeCancellation,
  progress: ComputeProgress | null,
  yielder: Yielder,
): Promise<bigint> {
  const first =
    (await arctanReciprocal(
      5,
      scale,
      cancellation,
      (fraction) => progress?.(fraction * MACHIN_FIRST_SHARE, "π series 1 of 2"),
      yielder,
    )) * 16n;
  const second =
    (await arctanReciprocal(
      239,
      scale,
      cancellation,
      (fraction) => progress?.(MACHIN_FIRST_SHARE + fraction * (1 - MACHIN_FIRST_SHARE), "π series 2 of 2"),
      yielder,
    )) * 4n;
  return first - second;
}

/** arctan(1/x), scaled by 10^scale, by its alternating Taylor series. */
function arctanReciprocalSync(
  x: number,
  scale: number,
  cancellation: ComputeCancellation,
  progress: ((fraction: number) => void) | null,
): bigint {
  const bigX = BigInt(x);
  const xSquared = bigX * bigX;
  let power = powerOfTen(scale) / bigX;
  let sum = power;
  let divisor = 3n;
  let subtractNext = true;

  // Terms shrink by a factor of x² each step, so the series dies after about
  // scale / (2·log10 x) of them. Known up front, which is what makes a real
  // fraction possible rather than a spinner.
  const expectedTerms = Math.max(1, scale / (2 * Math.log10(x)));
  let iterations = 0;

  while (power !== 0n) {
    // Checked every term: one closure call is nothing beside a big-integer
    // division, and the alternative is an uncancellable multi-minute loop.
    if (cancellation()) throw new ComputeCancelled();

    power /= xSquared;
    const term = power / divisor;
    if (term === 0n) break;
    sum = subtractNext ? sum - term : sum + term;
    subtractNext = !subtractNext;
    divisor += 2n;

    iterations += 1;
    // Throttled: a million progress callbacks would cost more than the
    // arithmetic they are reporting on.
    if (progress && iterations % 256 === 0) {
      progress(Math.min(1, iterations / expectedTerms));
    }
  }
  return sum;
}

async function arctanReciprocal(
  x: number,
  scale: number,
  cancellation: ComputeCancellation,
  progress: ((fraction: number) => void) | null,
  yielder: Yielder,
): Promise<bigint> {
  const bigX = BigInt(x);
  const xSquared = bigX * bigX;
  let power = powerOfTen(scale) / bigX;
  let sum = power;
  let divisor = 3n;
  let subtractNext = true;

  const expectedTerms = Math.max(1, scale / (2 * Math.log10(x)));
  let iterations = 0;

  while (power !== 0n) {
    if (cancellation()) throw new ComputeCancelled();

    power /= xSquared;
    const term = power / divisor;
    if (term === 0n) break;
    sum = subtractNext ? sum - term : sum + term;
    subtractNext = !subtractNext;
    divisor += 2n;

    iterations += 1;
    if (progress && iterations % 256 === 0) {
      progress(Math.min(1, iterations / expectedTerms));
    }
    if (iterations % 64 === 0) await yielder.maybeYield();
  }
  return sum;
}

// ---------------------------------------------------------------------------
// e = Σ 1/k!, scaled. Each term is the previous divided by k, so the whole
// series needs only scalar division.

function eulerESync(
  scale: number,
  cancellation: ComputeCancellation,
  progress: ComputeProgress | null,
): bigint {
  let term = powerOfTen(scale);
  let sum = term;
  let k = 1n;
  // The term loses log10(k) digits each step; the series ends when the
  // accumulated loss passes `scale`. Tracking that sum gives a fraction
  // without needing Stirling's approximation.
  let digitsShed = 0;
  let iterations = 0;

  while (term !== 0n) {
    if (cancellation()) throw new ComputeCancelled();
    term /= k;
    sum += term;
    digitsShed += Math.log10(Number(k));
    k += 1n;
    iterations += 1;
    if (progress && iterations % 256 === 0) {
      progress(Math.min(1, digitsShed / Math.max(scale, 1)), "e series");
    }
    // 10^scale / k! underflows long before this, but a runaway loop is not an
    // acceptable failure mode.
    if (k > 1_000_000n) break;
  }
  return sum;
}

async function eulerE(
  scale: number,
  cancellation: ComputeCancellation,
  progress: ComputeProgress | null,
  yielder: Yielder,
): Promise<bigint> {
  let term = powerOfTen(scale);
  let sum = term;
  let k = 1n;
  let digitsShed = 0;
  let iterations = 0;

  while (term !== 0n) {
    if (cancellation()) throw new ComputeCancelled();
    term /= k;
    sum += term;
    digitsShed += Math.log10(Number(k));
    k += 1n;
    iterations += 1;
    if (progress && iterations % 256 === 0) {
      progress(Math.min(1, digitsShed / Math.max(scale, 1)), "e series");
    }
    if (iterations % 64 === 0) await yielder.maybeYield();
    if (k > 1_000_000n) break;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Square roots — ⌊√(value · 10^(2·scale))⌋, i.e. √value scaled by 10^scale.
//
// Digit-by-digit ("long division") extraction, which needs only add,
// subtract, compare, and multiply-by-scalar.

function integerSquareRootSync(
  value: number,
  scale: number,
  cancellation: ComputeCancellation,
  progress: ComputeProgress | null,
): bigint {
  // Work in pairs of decimal digits, which is what the algorithm consumes.
  const totalPairs = scale + 1;
  let remainder = 0n;
  let root = 0n;

  for (let pairIndex = 0; pairIndex < totalPairs; pairIndex++) {
    if (cancellation()) throw new ComputeCancelled();
    if (progress && pairIndex % 256 === 0) {
      progress(pairIndex / totalPairs, "root extraction");
    }
    // Bring down the next two digits: the first pair is the integer part,
    // every later pair is zero because the radicand's fractional expansion is
    // all zeros.
    const bringDown = pairIndex === 0 ? BigInt(value) : 0n;
    remainder = remainder * 100n + bringDown;

    // Find the largest d in 0...9 with (20·root + d)·d ≤ remainder.
    const twentyRoot = root * 20n;
    let chosen = 0n;
    let chosenProduct = 0n;
    for (let digit = 9n; digit >= 1n; digit--) {
      const candidate = (twentyRoot + digit) * digit;
      if (candidate <= remainder) {
        chosen = digit;
        chosenProduct = candidate;
        break;
      }
    }
    remainder -= chosenProduct;
    root = root * 10n + chosen;
  }
  return root;
}

async function integerSquareRoot(
  value: number,
  scale: number,
  cancellation: ComputeCancellation,
  progress: ComputeProgress | null,
  yielder: Yielder,
): Promise<bigint> {
  const totalPairs = scale + 1;
  let remainder = 0n;
  let root = 0n;

  for (let pairIndex = 0; pairIndex < totalPairs; pairIndex++) {
    if (cancellation()) throw new ComputeCancelled();
    if (progress && pairIndex % 256 === 0) {
      progress(pairIndex / totalPairs, "root extraction");
    }
    const bringDown = pairIndex === 0 ? BigInt(value) : 0n;
    remainder = remainder * 100n + bringDown;

    const twentyRoot = root * 20n;
    let chosen = 0n;
    let chosenProduct = 0n;
    for (let digit = 9n; digit >= 1n; digit--) {
      const candidate = (twentyRoot + digit) * digit;
      if (candidate <= remainder) {
        chosen = digit;
        chosenProduct = candidate;
        break;
      }
    }
    remainder -= chosenProduct;
    root = root * 10n + chosen;
    if (pairIndex % 64 === 0) await yielder.maybeYield();
  }
  return root;
}
