// Workload estimation and routing for heavy maths requests.
//
// The router collapses to two honest options: the fast on-device answer, and an
// explicit, cancellable long run on the phone that the wearer opts into.
// The estimate is the whole point — every workload carries a closed-form
// cost model so the offer can price the wait before doing any work.

import {
  type ComputeCancellation,
  type ComputeProgress,
  type MathConstantName,
  MAXIMUM_COMPUTED_DIGITS,
  MAXIMUM_FEASIBLE_DIGITS,
  NEVER_CANCELLED,
  constantSpokenName,
  deepFractionalDigits,
} from "./constant-digits";
import {
  type DigitCountResult,
  type DigitSearchOutcome,
  countInExpansion,
  locateDigits,
} from "./digit-search";
import { formatInt } from "./math-number";

// ---------------------------------------------------------------------------
// Durations

/**
 * Turns a seconds estimate into something worth reading out. Deliberately
 * coarse: the cost model behind these numbers is accurate to an order of
 * magnitude, not to the second, so "about 247 seconds" would be a precision
 * the estimate does not have.
 */
export function describeDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "no time at all";
  if (seconds < 1) return "under a second";
  if (seconds < 10) return `about ${Math.round(seconds)} seconds`;
  if (seconds < 60) return `about ${roundedTo(seconds, 5)} seconds`;

  const minutes = seconds / 60;
  if (minutes < 2) return "about a minute and a half";
  if (minutes < 60) return `about ${Math.round(minutes)} minutes`;

  const hours = minutes / 60;
  if (hours < 2) return "about an hour and a half";
  if (hours < 24) return `about ${Math.round(hours)} hours`;

  const days = hours / 24;
  if (days < 365) return `about ${Math.round(days)} days`;
  const years = days / 365;
  return years < 2 ? "well over a year" : `about ${Math.round(years)} years`;
}

/** Short form for the lens, where there is no room for a sentence. */
export function compactDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function roundedTo(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step);
}

// ---------------------------------------------------------------------------
// Workloads

export type MathWorkload =
  /** Generate the decimal expansion of a constant. */
  | { kind: "constantDigits"; constant: MathConstantName; count: number }
  /** Find a digit run inside a constant's expansion. */
  | { kind: "digitSearch"; constant: MathConstantName; pattern: string; occurrence: number }
  /** Count a digit run across the deepest available expansion. */
  | { kind: "digitCount"; constant: MathConstantName; pattern: string };

/**
 * Rough seconds on the phone. Machin with scalar big arithmetic is O(n²);
 * measured with V8 BigInt: 10,000 digits ≈ 0.06 s on an M-class core, so
 * ~0.35 s per (n/10k)² on a device-class core. It does not need to be
 * precise, only right about the ORDER OF MAGNITUDE, because the routing
 * threshold and the offers are separated by factors of thousands — and at
 * this value an hour reaches about a million digits, which is where any
 * five-digit run and most six-digit ones live.
 */
const SECONDS_PER_TEN_K_SQUARED = 0.35;

export function estimatedLocalSeconds(workload: MathWorkload): number {
  switch (workload.kind) {
    case "constantDigits": {
      const n = Math.max(workload.count, 1);
      return SECONDS_PER_TEN_K_SQUARED * (n / 10_000) * (n / 10_000);
    }
    case "digitSearch":
      // Dominated by generating enough digits to have a hope of finding the
      // run: a k-digit pattern first appears around 10^k places.
      return estimatedLocalSeconds({
        kind: "constantDigits",
        constant: workload.constant,
        count: expectedDepth(workload.pattern.length),
      });
    case "digitCount":
      return estimatedLocalSeconds({
        kind: "constantDigits",
        constant: workload.constant,
        count: expectedDepth(workload.pattern.length),
      });
  }
}

/**
 * How many decimal places the workload would have to reach to answer
 * properly, as opposed to however few it settled for.
 */
export function requiredDepth(workload: MathWorkload): number {
  switch (workload.kind) {
    case "constantDigits":
      return Math.max(workload.count, 1);
    case "digitSearch":
      // The n-th occurrence sits roughly n× as deep as the first.
      return expectedDepth(workload.pattern.length) * Math.max(workload.occurrence, 1);
    case "digitCount":
      return expectedDepth(workload.pattern.length);
  }
}

/** Roughly where a random run of `length` digits first appears. */
export function expectedDepth(patternLength: number): number {
  if (patternLength <= 0) return 1_000;
  // Cap so the estimator does not overflow on a silly pattern.
  const bounded = Math.min(patternLength, 12);
  return Math.max(Math.pow(10, bounded), 1_000);
}

export function describeWorkload(workload: MathWorkload): string {
  switch (workload.kind) {
    case "constantDigits":
      return `${formatInt(workload.count)} digits of ${constantSpokenName(workload.constant)}`;
    case "digitSearch":
      return `searching ${constantSpokenName(workload.constant)} for ${workload.pattern}`;
    case "digitCount":
      return `counting ${workload.pattern} in ${constantSpokenName(workload.constant)}`;
  }
}

// ---------------------------------------------------------------------------
// Offers

/**
 * An offer to grind the full-depth answer out on the phone. Produced when a
 * question needs a deeper expansion than the fast path holds. It is a value,
 * not an action: nothing runs until the caller accepts it, because the whole
 * point is that the wearer decides whether the wait is affordable right now.
 */
export type LongRunOffer = {
  /** What would be run. */
  workload: MathWorkload;
  /** The phone's own estimate for the full-depth run. */
  estimatedSeconds: number;
  /** Why the fast path could not settle it. */
  reason: string;
  /** How deep the run would go — digits, for the expansion workloads. */
  depth: number;
  /**
   * What was already answered without waiting, if anything. A shallow search
   * still ran, so the offer is "look further", not "look at all".
   */
  shallowAnswerDescription: string | null;
};

/** The sentence the answer view shows. */
export function offerPrompt(offer: LongRunOffer): string {
  return (
    `${offer.reason}. This phone can keep going to ${formatInt(offer.depth)} digits — ` +
    `${describeDuration(offer.estimatedSeconds)}. Run it anyway?`
  );
}

/** Two short rows for the lens. */
export function offerGlassesPrompt(offer: LongRunOffer): string {
  return `Keep going? ${compactDuration(offer.estimatedSeconds)}\n${formatInt(offer.depth)} digits on phone`;
}

/** Progress from a long local run, so a four-minute grind is not a dead screen. */
export type LongRunProgress = {
  /** 0…1, or null when the phase cannot estimate itself. */
  fraction: number | null;
  /** What it is doing right now. */
  stage: string;
  /** Seconds elapsed so far. */
  elapsedSeconds: number;
};

export function progressText(progress: LongRunProgress): string {
  if (progress.fraction === null) return progress.stage;
  return `${Math.round(progress.fraction * 100)}%  ${progress.stage}`;
}

/**
 * The longest run the phone will even OFFER to attempt once the wearer has
 * said they will wait. An hour reaches most five- and six-digit runs under
 * the cost model. Past it the offer is withheld rather than shown: proposing
 * a multi-hour grind that still might not answer the question is worse than
 * plainly saying this device cannot settle it.
 */
export const LONG_RUN_CEILING_SECONDS = 3600;

/**
 * Build the offer, or decline to make one. Withheld in two cases, both
 * because the wait would not buy an answer: the depth needed exceeds what
 * the phone can hold, or the run would take longer than the ceiling.
 */
export function longRunOffer(
  workload: MathWorkload,
  reason: string,
  shallow: string | null = null,
): LongRunOffer | null {
  const depth = requiredDepth(workload);
  if (depth <= MAXIMUM_COMPUTED_DIGITS) return null;
  if (depth > MAXIMUM_FEASIBLE_DIGITS) return null;

  const estimate = estimatedLocalSeconds({
    kind: "constantDigits",
    constant: workload.constant,
    count: depth,
  });
  if (estimate > LONG_RUN_CEILING_SECONDS) return null;

  return {
    workload,
    estimatedSeconds: estimate,
    reason,
    depth,
    shallowAnswerDescription: shallow,
  };
}

// ---------------------------------------------------------------------------
// Accepted runs

/**
 * Run the search at full depth on the phone. Only called once the wearer has
 * accepted the offer's stated wait. Async and chunked — the generators yield
 * to the event loop, and the cancellation closure is checked every term.
 */
export async function runAcceptedSearch(
  offer: LongRunOffer,
  cancellation: ComputeCancellation = NEVER_CANCELLED,
  progress: ComputeProgress | null = null,
): Promise<DigitSearchOutcome> {
  if (offer.workload.kind !== "digitSearch") {
    return { kind: "notFound", searchedDigits: 0 };
  }
  const expansion = await deepFractionalDigits(
    offer.workload.constant,
    offer.depth,
    cancellation,
    progress,
  );
  if (!expansion) return { kind: "notFound", searchedDigits: 0 };
  return locateDigits(offer.workload.pattern, expansion, offer.workload.occurrence);
}

/** Generate the accepted depth and count overlapping occurrences there. */
export async function runAcceptedCount(
  offer: LongRunOffer,
  cancellation: ComputeCancellation = NEVER_CANCELLED,
  progress: ComputeProgress | null = null,
): Promise<DigitCountResult> {
  if (offer.workload.kind !== "digitCount") {
    return { occurrences: 0, searchedDigits: 0 };
  }
  const expansion = await deepFractionalDigits(
    offer.workload.constant,
    offer.depth,
    cancellation,
    progress,
  );
  if (!expansion) return { occurrences: 0, searchedDigits: 0 };
  return countInExpansion(offer.workload.pattern, expansion);
}

/** Generate the digits at full depth, once the offer has been accepted. */
export async function runAcceptedDigits(
  offer: LongRunOffer,
  cancellation: ComputeCancellation = NEVER_CANCELLED,
  progress: ComputeProgress | null = null,
): Promise<string | null> {
  return deepFractionalDigits(offer.workload.constant, offer.depth, cancellation, progress);
}
