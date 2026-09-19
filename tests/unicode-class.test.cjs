// The NativeScript Android runtime embeds a V8 built without ICU, so a regex
// literal containing a Unicode property escape (`\p{L}`) cannot be parsed
// there. One anywhere in the app makes bundle.mjs fail to compile and takes the
// process down inside Application.onCreate, before any of our code runs — a
// crash no typecheck catches, because the syntax is valid ES2018.
//
// These pin the replacement classes and guard against `\p{` coming back.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { isLetter, NON_WORD_RUN, LETTER_CLASS, NUMBER_CLASS } = require("../.test-build/app/util/unicode-class.js");

const split = (text) => text.split(NON_WORD_RUN).filter((token) => token.length > 0);

test("the maths lexer's operator glyphs are not letters", () => {
  // If any of these read as a letter, tokenize() swallows them into an
  // identifier instead of reaching the operator switch.
  for (const glyph of ["×", "÷", "−", "≤", "≥", "√", "_", " ", "1"]) {
    assert.equal(isLetter(glyph), false, `expected ${JSON.stringify(glyph)} not to be a letter`);
  }
});

test("identifier characters are letters", () => {
  for (const glyph of ["x", "Q", "π", "µ", "é", "й"]) {
    assert.equal(isLetter(glyph), true, `expected ${JSON.stringify(glyph)} to be a letter`);
  }
});

test("prose splits on punctuation and whitespace", () => {
  assert.deepEqual(split("i am not happy, but angry"), ["i", "am", "not", "happy", "but", "angry"]);
  assert.deepEqual(split("cannot wait!! 100%"), ["cannot", "wait", "100"]);
  assert.deepEqual(split("hello—world (test)"), ["hello", "world", "test"]);
  assert.deepEqual(split("half-life (2004) — 9/10"), ["half", "life", "2004", "9", "10"]);
});

test("prose keeps accented and non-Latin words whole", () => {
  assert.deepEqual(split("café naïve résumé"), ["café", "naïve", "résumé"]);
  assert.deepEqual(split("привет мир 42"), ["привет", "мир", "42"]);
  assert.deepEqual(split("东京 tokyo"), ["东京", "tokyo"]);
});

test("a decomposed accent stays attached to its base letter", () => {
  // "e" + COMBINING ACUTE. `\p{L}` alone treated the mark as a separator and
  // split this into ["e"]; keeping combining marks out of the separator set
  // holds the grapheme together.
  assert.deepEqual(split("é combining"), ["é", "combining"]);
});

test("an unlisted character is kept as word content, never dropped", () => {
  // The separator set is stated positively so that anything it does not know
  // about — a minority script, a later Unicode addition — degrades to "stayed
  // joined" rather than "disappeared".
  const unassigned = "ꟲ"; // Latin Extended-D, absent from LETTER_CLASS
  assert.deepEqual(split(`alpha${unassigned}beta gamma`), [`alpha${unassigned}beta`, "gamma"]);
});

test("the class bodies build valid regexes", () => {
  assert.doesNotThrow(() => new RegExp(`[${LETTER_CLASS}]`));
  assert.doesNotThrow(() => new RegExp(`[${NUMBER_CLASS}]`));
  assert.doesNotThrow(() => new RegExp(`[^${LETTER_CLASS}${NUMBER_CLASS}]`));
});

test("no Unicode property escape survives anywhere in app/", () => {
  const appRoot = path.join(__dirname, "..", "app");

  const sources = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) sources.push(full);
    }
  })(appRoot);

  assert.ok(sources.length > 0, "found no sources to scan");

  // Comments may name the escape (this file's own header does); code may not.
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

  const offenders = sources.filter((file) =>
    /\\p\{/.test(stripComments(fs.readFileSync(file, "utf8"))),
  );

  assert.deepEqual(
    offenders.map((file) => path.relative(appRoot, file)),
    [],
    "Unicode property escapes crash the ICU-less V8 on the glasses' Android host",
  );
});
