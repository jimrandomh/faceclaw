// Letter and digit character classes that avoid Unicode property escapes.
//
// The NativeScript Android runtime embeds a V8 built without ICU, so a regex
// literal containing `\p{...}` cannot be *parsed* there. Since the app ships as
// one ES module, a single such literal anywhere makes the whole of bundle.mjs
// fail to compile with
//   SyntaxError: Invalid regular expression: /\p{L}/: Invalid property name
// which kills the process inside Application.onCreate, before any of our code
// runs. The ranges below are plain ECMAScript and parse on every engine.
//
// Coverage is the BMP only: a letter encoded as a surrogate pair (CJK ext. B,
// Deseret, Old Italic, ...) is not classified as a letter. `\p{L}` did cover
// those; nothing in this app has a use for them today, and the alternative is
// surrogate bookkeeping at every call site.

/** Class body — no enclosing brackets — approximating `\p{L}` over the BMP. */
export const LETTER_CLASS =
  "A-Za-z" +
  "\\u00AA\\u00B5\\u00BA" + // ª µ º
  "\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02AF" + // Latin-1 sup. + ext. A/B + IPA, minus × and ÷
  "\\u0386\\u0388-\\u038A\\u038C\\u038E-\\u03A1\\u03A3-\\u03FF" + // Greek (incl. π), minus its punctuation
  "\\u0400-\\u052F" + // Cyrillic + supplement
  "\\u0531-\\u0556\\u0561-\\u0587" + // Armenian
  "\\u05D0-\\u05EA\\u05EF-\\u05F2" + // Hebrew
  "\\u0620-\\u064A\\u066E-\\u06D3\\u06D5" + // Arabic
  "\\u02B0-\\u02C1\\u02C6-\\u02D1\\u02E0-\\u02E4" + // Modifier letters
  "\\u0710-\\u072F\\u0780-\\u07B1" + // Syriac, Thaana
  "\\u0900-\\u097F\\u0980-\\u09FF\\u0A00-\\u0A7F\\u0A80-\\u0AFF" + // Devanagari, Bengali, Gurmukhi, Gujarati
  "\\u0B00-\\u0B7F\\u0B80-\\u0BFF\\u0C00-\\u0C7F\\u0C80-\\u0CFF" + // Oriya, Tamil, Telugu, Kannada
  "\\u0D00-\\u0D7F\\u0D80-\\u0DFF" + // Malayalam, Sinhala
  "\\u0E01-\\u0E3A\\u0E40-\\u0E4E\\u0E81-\\u0EDF" + // Thai, Lao
  "\\u0F40-\\u0FBC" + // Tibetan
  "\\u1000-\\u109F" + // Myanmar
  "\\u10A0-\\u10FF\\u2D00-\\u2D2F" + // Georgian + supplement
  "\\u1200-\\u137F\\u1380-\\u139F" + // Ethiopic
  "\\u13A0-\\u13FD\\u1400-\\u167F" + // Cherokee, Canadian Aboriginal syllabics
  "\\u1780-\\u17DC" + // Khmer
  "\\u1820-\\u18AA" + // Mongolian
  "\\u1E00-\\u1EFF" + // Latin extended additional (Vietnamese)
  "\\u1F00-\\u1FFF" + // Greek extended
  "\\u2C60-\\u2C7F\\u2C80-\\u2CFF\\u2D30-\\u2D67" + // Latin ext. C/D, Coptic, Tifinagh
  "\\u3041-\\u3096\\u30A1-\\u30FA\\u30FC" + // Hiragana, Katakana
  "\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF" + // CJK
  "\\uA500-\\uA62B\\uA640-\\uA69F" + // Vai, Cyrillic extended-B
  "\\u1100-\\u11FF\\u3130-\\u318F\\uA960-\\uA97C\\uAC00-\\uD7A3"; // Hangul

/** Class body — no enclosing brackets — approximating `\p{N}` over the BMP. */
export const NUMBER_CLASS =
  "0-9" +
  "\\u00B2\\u00B3\\u00B9\\u00BC-\\u00BE" + // ² ³ ¹ ¼ ½ ¾
  "\\u0660-\\u0669\\u06F0-\\u06F9" + // Arabic-Indic
  "\\u0966-\\u096F\\u09E6-\\u09EF" + // Devanagari, Bengali
  "\\u0E50-\\u0E59" + // Thai
  "\\uFF10-\\uFF19"; // Fullwidth

const LETTER_RE = new RegExp(`[${LETTER_CLASS}]`);

/**
 * True when `character` contains a letter. Stands in for `/\p{L}/u.test`.
 *
 * Used by the maths lexer, whose alphabet is small and known: ASCII identifiers
 * plus the operator glyphs it enumerates by hand. Over-inclusiveness is cheap
 * there — an unrecognised letter becomes an identifier that resolves to no
 * known function, which is already a handled error.
 */
export function isLetter(character: string): boolean {
  return LETTER_RE.test(character);
}

/**
 * Separator runs for word-splitting prose — whitespace, punctuation, and
 * symbols. Stands in for `/[^\p{L}\p{N}]+/u`.
 *
 * Stated as what to *split on* rather than as the complement of LETTER_CLASS,
 * because the two directions fail differently. Complementing the table would
 * make every letter it omits (minority scripts, later Unicode additions) act as
 * a separator, silently shredding that text into fragments. Listing separators
 * instead means an unlisted character is kept as word content: the tokenizer
 * degrades to "this stayed joined" rather than "this disappeared".
 *
 * Combining marks are deliberately absent, so a decomposed "e" + U+0301 stays
 * one token — `\p{L}` alone would have split it.
 *
 * Deliberately not global: `String.prototype.split` ignores `lastIndex`, so one
 * shared instance is safe to reuse across call sites.
 */
export const NON_WORD_RUN = new RegExp(
  "[\\s" +
    "\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E" + // ASCII punctuation
    "\\u00A0-\\u00A9\\u00AB-\\u00B1\\u00B4\\u00B6-\\u00B8\\u00BB\\u00BF\\u00D7\\u00F7" + // Latin-1 punctuation/symbols, minus superscripts
    "\\u02C2-\\u02C5\\u02D2-\\u02DF\\u02E5-\\u02EB\\u02ED\\u02EF-\\u02FF" + // Spacing modifier symbols, minus modifier letters
    "\\u2000-\\u206F" + // General punctuation (dashes, quotes, bullets)
    "\\u20A0-\\u20BF" + // Currency
    "\\u2190-\\u245F\\u2500-\\u2BFF" + // Arrows/maths/geometric/misc symbols, skipping
    // letterlike (U+2100-214F), number forms (U+2150-218F), enclosed alphanumerics (U+2460-24FF)
    "\\u3000-\\u303F" + // CJK punctuation
    "\\uFE30-\\uFE4F\\uFE50-\\uFE6B" + // CJK compatibility + small form punctuation
    "\\uFF00-\\uFF0F\\uFF1A-\\uFF20\\uFF3B-\\uFF40\\uFF5B-\\uFF65" + // Fullwidth punctuation
    "]+",
);
