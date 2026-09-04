/**
 * Follows a speaker through a script from live speech-to-text. Pure logic
 * (no NativeScript imports) so it runs under plain node for the tests.
 *
 * The script is tokenized once into display tokens; the subset with a
 * non-empty normalized key are the "words" the tracker aligns against. The
 * tracker keeps `position`: the index (in word space) of the next word the
 * speaker is expected to say. Each transcript update (replace semantics: the
 * whole current utterance, partial or final) re-aligns the tail of the
 * transcript against a window of script words around the current position,
 * with a local alignment that tolerates misrecognized, skipped and ad-libbed
 * words, and moves the position to just after the last aligned script word.
 */

export type ScriptToken = {
  /** The token as written, for display. */
  text: string;
  /** Paragraph number (newline-separated), for layout. */
  paragraph: number;
  /** Lowercased alphanumeric key, or "" for punctuation-only tokens. */
  key: string;
  /** Index into the tracker's word list, or -1 when key is empty. */
  wordIndex: number;
};

export type TokenizedScript = {
  tokens: ScriptToken[];
  /** Normalized keys of the trackable tokens, in order. */
  words: string[];
  /** Token index of each word. */
  wordTokens: number[];
};

/** Lowercase, strip everything but letters/digits, fold common apostrophes. */
export function normalizeWord(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function tokenizeScript(text: string): TokenizedScript {
  const tokens: ScriptToken[] = [];
  const words: string[] = [];
  const wordTokens: number[] = [];
  const paragraphs = text.replace(/\r/g, "").split("\n");
  for (let paragraph = 0; paragraph < paragraphs.length; paragraph++) {
    for (const raw of paragraphs[paragraph]!.split(/\s+/)) {
      if (!raw) continue;
      const key = normalizeWord(raw);
      const wordIndex = key ? words.length : -1;
      if (key) {
        words.push(key);
        wordTokens.push(tokens.length);
      }
      tokens.push({ text: raw, paragraph, key, wordIndex });
    }
  }
  return { tokens, words, wordTokens };
}

/** Split a transcript into normalized keys, dropping empties. */
export function transcriptKeys(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeWord)
    .filter((key) => key.length > 0);
}

// Function words match so often that on their own they say little about
// where the speaker is; they count for less than content words.
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "is", "it", "its",
  "i", "we", "you", "he", "she", "they", "that", "this", "as", "be", "are", "was", "were",
  "with", "by", "so", "if", "not", "no", "do", "have", "has", "had", "will", "can",
]);

const MATCH_SCORE = 3;
const STOP_WORD_MATCH_SCORE = 1.5;
/** A fuzzy (edit-distance 1) or prefix match: real evidence, but weaker. */
const FUZZY_MATCH_SCORE = 2;
const MISMATCH_SCORE = -2;
const GAP_SCORE = -1.5;
/** The alignment must be worth at least this to move the position at all. */
const MIN_ALIGNMENT_SCORE = 4.5;
const MIN_MATCHED_WORDS = 2;
/** Per-word cost of ending an alignment away from the expected position (a tie-breaker). */
const FORWARD_DISTANCE_COST = 0.02;
const BACKWARD_DISTANCE_COST = 0.1;

export type TrackerOptions = {
  /** Script words before the current position that stay in play (repeats, backtracking). */
  back?: number;
  /** Script words after the current position that stay in play (skipping ahead). */
  ahead?: number;
  /** Only the last this-many transcript words are aligned. */
  tailWords?: number;
};

const DEFAULT_OPTIONS: Required<TrackerOptions> = { back: 30, ahead: 160, tailWords: 20 };

/**
 * Edit distance capped at 1 (true when the strings are within one edit),
 * which covers the typical STT slip: a dropped/extra letter or a substitution.
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const lengthDelta = a.length - b.length;
  if (lengthDelta > 1 || lengthDelta < -1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (short.length === long.length) {
      i++;
    }
    j++;
  }
  return edits + (long.length - j) <= 1;
}

/** Score of aligning transcript key `spoken` with script key `expected`. */
function matchScore(spoken: string, expected: string, isLastSpoken: boolean): number {
  if (spoken === expected) {
    return STOP_WORDS.has(expected) ? STOP_WORD_MATCH_SCORE : MATCH_SCORE;
  }
  // The final transcript word is often still being recognized: a prefix of
  // the script word counts, once it is long enough not to be noise.
  if (isLastSpoken && spoken.length >= 2 && expected.length > spoken.length && expected.startsWith(spoken)) {
    return FUZZY_MATCH_SCORE;
  }
  if (spoken.length >= 5 && expected.length >= 5 && withinOneEdit(spoken, expected)) {
    return FUZZY_MATCH_SCORE;
  }
  return MISMATCH_SCORE;
}

export type AlignmentResult = {
  /** Index (in the script word list) of the word after the last aligned one; the new position. */
  position: number;
  score: number;
  matchedWords: number;
};

/**
 * Align the transcript tail against script words [windowStart, windowEnd).
 * Local alignment (free start on both sides) that must consume the last
 * transcript word and may end anywhere in the window. Returns null when the
 * best alignment is too weak to trust.
 */
export function alignTail(
  words: readonly string[],
  spoken: readonly string[],
  windowStart: number,
  windowEnd: number,
  expectedPosition: number,
): AlignmentResult | null {
  const m = spoken.length;
  const n = windowEnd - windowStart;
  if (m === 0 || n <= 0) return null;

  // H[i][j]: best score of an alignment ending with spoken[i-1] / window[j-1]
  // (or a gap), clamped at 0 (free start). Matches counts how many spoken
  // words matched along the path that produced H[i][j].
  const width = n + 1;
  const score = new Float64Array((m + 1) * width);
  const matches = new Uint16Array((m + 1) * width);
  for (let i = 1; i <= m; i++) {
    const spokenWord = spoken[i - 1]!;
    const isLast = i === m;
    for (let j = 1; j <= n; j++) {
      const here = i * width + j;
      const s = matchScore(spokenWord, words[windowStart + j - 1]!, isLast);
      const diagonal = score[here - width - 1]! + s;
      const skipScript = score[here - 1]! + GAP_SCORE;
      const skipSpoken = score[here - width]! + GAP_SCORE;
      let best = 0;
      let bestMatches = 0;
      if (diagonal > best) {
        best = diagonal;
        bestMatches = matches[here - width - 1]! + (s > 0 ? 1 : 0);
      }
      if (skipScript > best) {
        best = skipScript;
        bestMatches = matches[here - 1]!;
      }
      if (skipSpoken > best) {
        best = skipSpoken;
        bestMatches = matches[here - width]!;
      }
      score[here] = best;
      matches[here] = bestMatches;
    }
  }

  let bestColumn = -1;
  let bestAdjusted = -Infinity;
  for (let j = 1; j <= n; j++) {
    const raw = score[m * width + j]!;
    if (raw <= 0) continue;
    const position = windowStart + j;
    const distance = position - expectedPosition;
    const adjusted = raw - (distance >= 0 ? distance * FORWARD_DISTANCE_COST : -distance * BACKWARD_DISTANCE_COST);
    if (adjusted > bestAdjusted) {
      bestAdjusted = adjusted;
      bestColumn = j;
    }
  }
  if (bestColumn < 0) return null;
  const rawScore = score[m * width + bestColumn]!;
  const matchedWords = matches[m * width + bestColumn]!;
  if (rawScore < MIN_ALIGNMENT_SCORE || matchedWords < MIN_MATCHED_WORDS) return null;
  return { position: windowStart + bestColumn, score: rawScore, matchedWords };
}

export class ScriptTracker {
  private readonly options: Required<TrackerOptions>;
  /** Index of the next word the speaker is expected to say (0..words.length). */
  position = 0;

  constructor(
    private readonly words: readonly string[],
    options: TrackerOptions = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get wordCount(): number {
    return this.words.length;
  }

  /** Jump the expected position (manual scroll, restart). */
  anchor(position: number): void {
    this.position = Math.max(0, Math.min(this.words.length, position));
  }

  /**
   * Apply a transcript update (the whole current utterance, partial or
   * final). Returns true when the position moved.
   */
  feed(text: string): boolean {
    const keys = transcriptKeys(text);
    if (keys.length === 0) return false;
    const tail = keys.length > this.options.tailWords ? keys.slice(-this.options.tailWords) : keys;
    const windowStart = Math.max(0, this.position - this.options.back);
    const windowEnd = Math.min(this.words.length, this.position + this.options.ahead);
    const result = alignTail(this.words, tail, windowStart, windowEnd, this.position);
    if (!result || result.position === this.position) return false;
    this.position = result.position;
    return true;
  }
}
