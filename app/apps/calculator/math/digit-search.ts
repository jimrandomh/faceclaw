// Finds a digit sequence inside the expansion of a constant.
//
// The position convention is fixed and stated everywhere it is reported:
// **decimal places after the point, 1-based**. So the first `11` in π is at
// 94–95, because π = 3.(1)4159… and the 94th digit after the point is the
// first `1` of that pair. Every off-by-one complaint about this kind of
// feature is a convention that was never written down, so it is written down.

import {
  type MathConstantName,
  MAXIMUM_COMPUTED_DIGITS,
  fractionalDigits,
} from "./constant-digits";

export type DigitCountResult = {
  occurrences: number;
  searchedDigits: number;
};

export type DigitMatch = {
  /** 1-based decimal place of the first digit of the match. */
  start: number;
  /** 1-based decimal place of the last digit. */
  end: number;
  /** The digits either side, for the reveal. */
  context: string;
  /** Where the match sits inside `context`, as an offset. */
  contextOffset: number;
};

/** `...3421 ·11· 70679...` with the match marked. */
export function highlightedMatch(match: DigitMatch, marker = "·"): string {
  const length = match.end - match.start + 1;
  if (match.contextOffset < 0 || match.contextOffset + length > match.context.length) {
    return match.context;
  }
  const before = match.context.slice(0, match.contextOffset);
  const middle = match.context.slice(match.contextOffset, match.contextOffset + length);
  const after = match.context.slice(match.contextOffset + length);
  return `${before}${marker}${middle}${marker}${after}`;
}

export type DigitSearchOutcome =
  | { kind: "found"; match: DigitMatch }
  /**
   * Searched the whole available expansion and did not find it. Carries how
   * far the search actually reached, because "not in π" and "not in the first
   * 20,000 digits of π" are very different claims and only one of them is
   * true.
   */
  | { kind: "notFound"; searchedDigits: number }
  | { kind: "invalidPattern"; reason: string };

/** How many digits either side of a hit to return. */
export const DEFAULT_CONTEXT_RADIUS = 6;

export type DigitSource = (constant: MathConstantName, count: number) => string | null;

const DEFAULT_SOURCE: DigitSource = (constant, count) => fractionalDigits(constant, count);

/** Find the `occurrence`-th appearance of `pattern`. */
export function findDigits(
  pattern: string,
  constant: MathConstantName,
  occurrence = 1,
  requested: number = MAXIMUM_COMPUTED_DIGITS,
  contextRadius: number = DEFAULT_CONTEXT_RADIUS,
  digitSource: DigitSource = DEFAULT_SOURCE,
): DigitSearchOutcome {
  const cleaned = pattern.replace(/\D/g, "");
  if (!cleaned) return { kind: "invalidPattern", reason: "Give a sequence of digits to look for" };
  if (occurrence < 1) return { kind: "invalidPattern", reason: "Occurrence must be 1 or more" };

  const expansion = digitSource(constant, requested);
  if (!expansion) return { kind: "notFound", searchedDigits: 0 };

  return locateDigits(cleaned, expansion, occurrence, contextRadius);
}

/**
 * Search an expansion the caller already has — the path an accepted long run
 * uses, where the digits come from the deep generator rather than the
 * shallow cache.
 */
export function locateDigits(
  pattern: string,
  expansion: string,
  occurrence = 1,
  contextRadius: number = DEFAULT_CONTEXT_RADIUS,
): DigitSearchOutcome {
  if (pattern.length > expansion.length) {
    return { kind: "notFound", searchedDigits: expansion.length };
  }

  let seen = 0;
  // Plain scan rather than a substring search: overlapping matches count
  // ("111" contains "11" twice), and indexOf-with-skip would miss the
  // overlap.
  for (let index = 0; index <= expansion.length - pattern.length; index++) {
    let matched = true;
    for (let offset = 0; offset < pattern.length; offset++) {
      if (expansion[index + offset] !== pattern[offset]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    seen += 1;
    if (seen !== occurrence) continue;

    const contextStart = Math.max(0, index - contextRadius);
    const contextEnd = Math.min(expansion.length, index + pattern.length + contextRadius);
    return {
      kind: "found",
      match: {
        start: index + 1,
        end: index + pattern.length,
        context: expansion.slice(contextStart, contextEnd),
        contextOffset: index - contextStart,
      },
    };
  }
  return { kind: "notFound", searchedDigits: expansion.length };
}

/** How many times the pattern appears in the available expansion. */
export function countDigits(
  pattern: string,
  constant: MathConstantName,
  requested: number = MAXIMUM_COMPUTED_DIGITS,
  digitSource: DigitSource = DEFAULT_SOURCE,
): DigitCountResult {
  const cleaned = pattern.replace(/\D/g, "");
  if (!cleaned) return { occurrences: 0, searchedDigits: 0 };
  const expansion = digitSource(constant, requested);
  if (!expansion) return { occurrences: 0, searchedDigits: 0 };
  return countInExpansion(cleaned, expansion);
}

/** Count overlapping occurrences inside an expansion the caller already has. */
export function countInExpansion(pattern: string, expansion: string): DigitCountResult {
  if (pattern.length > expansion.length) {
    return { occurrences: 0, searchedDigits: expansion.length };
  }
  let total = 0;
  for (let index = 0; index <= expansion.length - pattern.length; index++) {
    let matched = true;
    for (let offset = 0; offset < pattern.length; offset++) {
      if (expansion[index + offset] !== pattern[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) total += 1;
  }
  return { occurrences: total, searchedDigits: expansion.length };
}

/** The digits at a given range of decimal places, 1-based inclusive. */
export function digitsAt(
  constant: MathConstantName,
  start: number,
  end: number,
  digitSource: DigitSource = DEFAULT_SOURCE,
): string | null {
  if (start < 1 || end < start) return null;
  const expansion = digitSource(constant, end);
  if (!expansion || expansion.length < end) return null;
  return expansion.slice(start - 1, end);
}

/**
 * How deep you would expect to search before a random `length`-digit string
 * turns up: 10^length places, on average.
 *
 * Reported alongside a notFound so the answer is honest about whether the
 * search was ever likely to succeed — an eight-digit birthday first appears
 * around the hundred-millionth digit, which no on-device expansion is going
 * to reach.
 */
export function expectedFirstPosition(patternLength: number): number | null {
  if (patternLength <= 0 || patternLength > 18) return null;
  return Math.pow(10, patternLength);
}
