// Turns a spoken utterance into something the parser can read. ASR does not
// emit `2x^2 + 3x - 5 = 0`; it emits "two x squared plus three x minus five
// equals zero", and on a bad pass "2 x squared plus 3x minus 5 = 0". Every
// rule here exists because one of those shapes has to land on the same tree.
//
// Deliberately NOT an LLM pass: a misheard equation should fail visibly at
// the parser rather than be silently "corrected" into a different problem.

import { ALL_CONSTANTS, ALL_FUNCTIONS } from "./expression";

export function normalizeSpoken(raw: string): string {
  let text = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/’/g, "'");

  text = stripTrailingDiscourse(text);
  text = stripPreamble(text);
  text = applyPhrases(text, FUNCTION_PHRASES);
  text = applyPhrases(text, RELATION_PHRASES);
  text = applyPhrases(text, OPERATOR_PHRASES);
  // Number words BEFORE powers: "two to the power of five" must become
  // "2 to the power of 5" first, or the power rule collapses it to
  // "two^five" and the parser sees two variables. Ordinals ("fifth") are
  // untouched by the number pass, so "to the fifth" still resolves after.
  text = applyNumberWords(text);
  text = applyPowerPhrases(text);
  text = applyFractionPhrases(text);
  text = applyPhrases(text, CONSTANT_PHRASES);
  text = collapseDigitGroups(text);
  text = insertImplicitMultiplication(text);

  return text.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Preamble

const TRAILING_PUNCTUATION = /^[ .,!?;:]+|[ .,!?;:]+$/g;

/**
 * Remove terminal speech-recognition filler that is not part of the problem.
 *
 * Always-on transcription commonly finalizes a valid equation together with
 * the next conversational beat (`3x plus 1. Thank you.`). Leaving that suffix
 * attached makes the deterministic parser reject otherwise complete
 * arithmetic and sends the calculator through its optional model-rewrite
 * fallback — turning an offline feature into an API-key error for users
 * without a cloud provider configured.
 */
export function stripTrailingDiscourse(text: string): string {
  const phrases = ["thank you", "thanks", "please", "okay", "ok"].sort((a, b) => b.length - a.length);
  let result = text.replace(TRAILING_PUNCTUATION, "");
  let changed = true;
  while (changed) {
    changed = false;
    for (const phrase of phrases) {
      if (result === phrase) {
        result = "";
        changed = true;
        break;
      }
      const suffix = " " + phrase;
      if (result.endsWith(suffix)) {
        result = result.slice(0, -suffix.length).replace(TRAILING_PUNCTUATION, "");
        changed = true;
        break;
      }
    }
  }
  return result;
}

/**
 * "solve two x plus one equals five" → "two x plus one equals five". The
 * command word is consumed by the caller (it chooses the mode); what reaches
 * the parser must be only the mathematics.
 */
const PREAMBLES = [
  "can you solve",
  "please solve",
  "solve for me",
  "work out",
  "figure out",
  "calculate",
  "compute",
  "evaluate",
  "simplify",
  "solve",
  "what is",
  "whats",
  "what's",
  "how much is",
  "tell me",
  "the answer to",
  "the equation",
  "the expression",
  "graph",
  "plot",
].sort((a, b) => b.length - a.length);

export function stripPreamble(text: string): string {
  let result = text.trim();
  let changed = true;
  // Loop: "can you solve what is 2 plus 2" has two stacked preambles.
  while (changed) {
    changed = false;
    for (const preamble of PREAMBLES) {
      if (result.startsWith(preamble + " ")) {
        result = result.slice(preamble.length + 1);
        changed = true;
        break;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Phrase tables

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Longest-first replacement. "less than or equal to" must be tried before
 * "less than", or the tail becomes a stray "or equal to".
 */
function applyPhrases(text: string, phrases: readonly [string, string][]): string {
  let result = text;
  const sorted = [...phrases].sort((a, b) => b[0].length - a[0].length);
  for (const [phrase, replacement] of sorted) {
    result = result.replace(new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "g"), replacement);
  }
  return result;
}

const RELATION_PHRASES: readonly [string, string][] = [
  ["is less than or equal to", "<="],
  ["less than or equal to", "<="],
  ["is greater than or equal to", ">="],
  ["greater than or equal to", ">="],
  ["is at most", "<="],
  ["at most", "<="],
  ["is at least", ">="],
  ["at least", ">="],
  ["is less than", "<"],
  ["less than", "<"],
  ["is greater than", ">"],
  ["greater than", ">"],
  ["is equal to", "="],
  ["equal to", "="],
  ["equals", "="],
  ["is the same as", "="],
];

const OPERATOR_PHRASES: readonly [string, string][] = [
  ["multiplied by", "*"],
  ["times", "*"],
  ["product of", "*"],
  ["divided by", "/"],
  ["over", "/"],
  ["split by", "/"],
  ["plus", "+"],
  ["added to", "+"],
  ["and then add", "+"],
  ["minus", "-"],
  ["subtract", "-"],
  ["take away", "-"],
  ["less", "-"],
  ["modulo", "%"],
  ["mod", "%"],
  ["open paren", "("],
  ["open parenthesis", "("],
  ["open bracket", "("],
  ["close paren", ")"],
  ["close parenthesis", ")"],
  ["close bracket", ")"],
  ["negative", "-"],
  ["minus sign", "-"],
  // "15 percent of 240" is 15/100 × 240. Mapping `percent` to the modulo
  // operator (which shares the glyph) turned every percentage question into a
  // remainder question — 15 % 240 = 15, silently wrong.
  ["percent of", "/100 *"],
  ["percent", "/100"],
];

const FUNCTION_PHRASES: readonly [string, string][] = [
  ["square root of", "sqrt"],
  ["the square root of", "sqrt"],
  ["root of", "sqrt"],
  ["cube root of", "cbrt"],
  ["natural log of", "ln"],
  ["natural log", "ln"],
  ["log base ten of", "log10"],
  ["log base 10 of", "log10"],
  ["log base two of", "log2"],
  ["log base 2 of", "log2"],
  ["log of", "log10"],
  ["absolute value of", "abs"],
  ["the absolute value of", "abs"],
  ["sine of", "sin"],
  ["cosine of", "cos"],
  ["tangent of", "tan"],
  ["arc sine of", "asin"],
  ["arc cosine of", "acos"],
  ["arc tangent of", "atan"],
  ["inverse sine of", "asin"],
  ["inverse cosine of", "acos"],
  ["inverse tangent of", "atan"],
  ["factorial of", "factorial"],
  ["e to the power of", "exp"],
];

const CONSTANT_PHRASES: readonly [string, string][] = [
  ["pi", "pi"],
  ["tau", "tau"],
  ["euler's number", "e"],
  ["eulers number", "e"],
];

// ---------------------------------------------------------------------------
// Powers

/** "x squared", "x to the power of three", "x cubed", "two to the fifth". */
export function applyPowerPhrases(text: string): string {
  let result = text;
  const ordinalPowers: readonly [string, string][] = [
    ["squared", "^2"],
    ["cubed", "^3"],
  ];
  for (const [phrase, replacement] of ordinalPowers) {
    result = result.replace(new RegExp(`\\s*\\b${phrase}\\b`, "g"), replacement);
  }
  // "to the power of N" / "to the N power" / "to the N"
  for (const pattern of [
    /\s*to the power of\s+/g,
    /\s*raised to the power of\s+/g,
    /\s*raised to\s+/g,
    /\s*to the\s+(?=[0-9])/g,
  ]) {
    result = result.replace(pattern, "^");
  }
  // Ordinal exponents: "to the fifth" was normalised to "^fifth" above.
  const ordinals: readonly [string, string][] = [
    ["first", "1"],
    ["second", "2"],
    ["third", "3"],
    ["fourth", "4"],
    ["fifth", "5"],
    ["sixth", "6"],
    ["seventh", "7"],
    ["eighth", "8"],
    ["ninth", "9"],
    ["tenth", "10"],
  ];
  for (const [word, digit] of ordinals) {
    result = result.replace(new RegExp(`\\^\\s*${word}(\\s+power)?\\b`, "g"), `^${digit}`);
    result = result.replace(new RegExp(`\\s*to the ${word}(\\s+power)?\\b`, "g"), `^${digit}`);
  }
  // Postfix "seven factorial" — the function table only covers the prefix
  // form ("factorial of seven").
  result = result.replace(/(\d+|\))\s*\bfactorial\b/g, "$1!");
  return result.replace(/\^\s+/g, "^");
}

// ---------------------------------------------------------------------------
// Fractions

/** "three over four", "two thirds", "one half". */
export function applyFractionPhrases(text: string): string {
  let result = text;
  const denominators: readonly [string, number][] = [
    ["halves", 2],
    ["half", 2],
    ["thirds", 3],
    ["third", 3],
    ["quarters", 4],
    ["quarter", 4],
    ["fourths", 4],
    ["fourth", 4],
    ["fifths", 5],
    ["fifth", 5],
    ["sixths", 6],
    ["sixth", 6],
    ["eighths", 8],
    ["eighth", 8],
    ["tenths", 10],
    ["tenth", 10],
  ];
  for (const [word, denominator] of denominators) {
    // Only when a number precedes it — "a third of the guests" is not
    // arithmetic, but "two thirds" is.
    result = result.replace(new RegExp(`\\b(\\d+)\\s+${word}\\b`, "g"), `($1/${denominator})`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Number words

const UNITS: readonly [string, number][] = [
  ["zero", 0],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
];

const TENS: readonly [string, number][] = [
  ["twenty", 20],
  ["thirty", 30],
  ["forty", 40],
  ["fifty", 50],
  ["sixty", 60],
  ["seventy", 70],
  ["eighty", 80],
  ["ninety", 90],
];

/**
 * Fold English number words into digits, including compounds
 * ("twenty five" → 25, "three hundred" → 300, "two thousand ten" → 2010).
 */
export function applyNumberWords(text: string): string {
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  const output: string[] = [];
  let index = 0;

  while (index < tokens.length) {
    const [value, consumed] = parseNumberPhrase(tokens, index);
    if (value !== null && consumed > 0) {
      output.push(String(value));
      index += consumed;
    } else {
      output.push(tokens[index]!);
      index += 1;
    }
  }
  return output.join(" ");
}

/**
 * What the previous token was, which is what decides whether the next one
 * continues the same number or starts a new one. "twenty five" is 25;
 * "five five" is two numbers; "one hundred forty four" is 144.
 */
type NumberTokenKind = "none" | "unit" | "ten" | "hundred" | "scale";

/**
 * Greedy left-to-right accumulation with scale words. Returns [null, 0] when
 * the token at `start` does not begin a number phrase.
 */
function parseNumberPhrase(tokens: string[], start: number): [number | null, number] {
  let total = 0;
  let current = 0;
  let consumed = 0;
  let matchedAnything = false;
  let previous: NumberTokenKind = "none";

  let index = start;
  while (index < tokens.length) {
    const token = tokens[index]!.replace(/^[,-]+|[,-]+$/g, "");
    const unit = UNITS.find(([word]) => word === token)?.[1];
    const ten = TENS.find(([word]) => word === token)?.[1];

    if (unit !== undefined) {
      // A unit may follow a ten ("twenty five"), a hundred ("a hundred
      // four"), or a scale ("two thousand ten") — but not another unit, which
      // is two separate numbers.
      if (previous === "unit") break;
      current += unit;
      previous = "unit";
    } else if (ten !== undefined) {
      // After "hundred", `current` is non-zero; bailing there turned
      // "one hundred forty four" into "100 44".
      if (previous !== "none" && previous !== "hundred" && previous !== "scale") break;
      current += ten;
      previous = "ten";
    } else if (token === "hundred") {
      if (previous !== "unit" && previous !== "ten" && previous !== "none") break;
      if (current === 0) current = 1;
      current *= 100;
      previous = "hundred";
    } else if (token === "thousand" || token === "million") {
      const scale = token === "thousand" ? 1_000 : 1_000_000;
      if (current === 0 && total === 0) current = 1;
      total += current * scale;
      current = 0;
      previous = "scale";
    } else if (token === "and" && matchedAnything && index + 1 < tokens.length && isNumberWord(tokens[index + 1]!)) {
      // "three hundred and five" — but a bare "and" elsewhere is not part of
      // the number.
      index += 1;
      consumed += 1;
      continue;
    } else {
      break;
    }
    matchedAnything = true;
    index += 1;
    consumed += 1;
  }

  if (!matchedAnything) return [null, 0];
  return [total + current, consumed];
}

function isNumberWord(token: string): boolean {
  const cleaned = token.replace(/^[,-]+|[,-]+$/g, "");
  return (
    UNITS.some(([word]) => word === cleaned) ||
    TENS.some(([word]) => word === cleaned) ||
    ["hundred", "thousand", "million"].includes(cleaned)
  );
}

// ---------------------------------------------------------------------------
// Digit groups

/**
 * ASR renders a dictated "four hundred and five" that it already digitised as
 * "4 05" or "400 5". The first is a spacing artefact and joins; the second is
 * genuinely ambiguous and is left alone.
 */
export function collapseDigitGroups(text: string): string {
  return text.replace(/\b(\d+)\s+(0\d+)\b/g, "$1$2");
}

// ---------------------------------------------------------------------------
// Implicit multiplication

/**
 * Names the implicit-multiplication repair must not split.
 */
export const RESERVED_WORDS: readonly string[] = [...ALL_FUNCTIONS, ...ALL_CONSTANTS, "log", "sqrt"];

/**
 * The subset that is CALLED, so a star between the name and its opening paren
 * is an artefact of the implicit-multiplication rules rather than a real
 * operator. Constants are excluded deliberately: `pi*(r+1)` must keep its
 * multiplication.
 */
export const RESERVED_FUNCTION_NAMES: readonly string[] = [...ALL_FUNCTIONS, "log", "sqrt"];

/**
 * "2x" and "3(x+1)" and "2 x" all mean multiplication. Inserting the `*` here
 * rather than in the parser keeps the grammar unambiguous, and makes the
 * normalised string something a wearer can read back and verify.
 */
export function insertImplicitMultiplication(text: string): string {
  let result = text;
  const rules: readonly [RegExp, string][] = [
    // number followed by a letter or an opening paren: 2x, 2(
    [/(\d)\s*([a-z(])/g, "$1*$2"],
    // closing paren followed by a number, letter, or paren: )x, )2, )(
    [/(\))\s*([a-z0-9(])/g, "$1*$2"],
    // a single-letter variable immediately followed by a paren
    [/(?<![a-z])([a-z])\s*(\()/g, "$1*$2"],
  ];
  for (const [pattern, replacement] of rules) {
    result = result.replace(pattern, replacement);
  }
  // The rules above will happily turn `sqrt(x)` into `sqr*t*(x)` and `2*x`
  // inside a known function name; repair the known names.
  //
  // The optional star belongs strictly BETWEEN the characters of a word.
  // Appending one after the final character too (`p\*?i\*?` for `pi`) made
  // the repair swallow a legitimate operator that merely FOLLOWED the word:
  // `2*pi*r` became `2*pir`, which then parsed as three unbound variables and
  // silently produced a different answer.
  //
  // A function name immediately before its opening paren is the one
  // exception: the rules above rewrite `sqrt(x)` to `sqr*t*(x)`, so that
  // trailing star really is spurious. A CONSTANT is never called, so a star
  // after `pi` or `e` is always a real multiplication — `pi*(r+1)` has to
  // keep it. Run the narrower function rule first, then the general
  // between-characters repair over everything.
  for (const name of RESERVED_FUNCTION_NAMES) {
    if (name.length <= 1) continue;
    const pattern = name.split("").join("\\*?") + "\\*?(?=\\()";
    result = result.replace(new RegExp(pattern, "g"), name);
  }
  for (const name of RESERVED_WORDS) {
    // A single-character constant such as `e` has nothing to repair between
    // characters, so it is skipped entirely.
    if (name.length <= 1) continue;
    const pattern = name.split("").join("\\*?");
    result = result.replace(new RegExp(pattern, "g"), name);
  }
  return result;
}
