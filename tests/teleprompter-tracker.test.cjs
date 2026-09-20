// Pins the Teleprompter's speech-to-script tracker: tokenization, the fuzzy
// word matcher, and the position tracking under realistic partial-transcript
// streams (replace semantics), including misrecognitions, ad-libs, skipped
// sentences and repeated phrases.
const test = require("node:test");
const assert = require("node:assert/strict");

const tracker = require("../.test-build/app/apps/teleprompter/script-tracker.js");

const SCRIPT = `Good evening, everyone. Thank you for coming tonight.

Four score and seven years ago our fathers brought forth on this continent
a new nation, conceived in liberty, and dedicated to the proposition that
all men are created equal.

Now we are engaged in a great civil war, testing whether that nation, or any
nation so conceived and so dedicated, can long endure. We are met on a great
battle-field of that war.

We have come to dedicate a portion of that field, as a final resting place
for those who here gave their lives that that nation might live.`;

/** Word index of the first occurrence of a normalized key, from `from`. */
function wordAt(script, key, from = 0) {
  const index = script.words.indexOf(key, from);
  assert.notEqual(index, -1, `script has ${key}`);
  return index;
}

/**
 * Feed an utterance the way a streaming recognizer delivers it: a growing
 * partial after every word, then the final. Returns the tracker position.
 */
function speak(t, utterance) {
  const words = utterance.split(/\s+/);
  for (let i = 1; i <= words.length; i++) {
    t.feed(words.slice(0, i).join(" "));
  }
  t.feed(utterance);
  return t.position;
}

test("tokenizeScript separates display tokens from trackable words", () => {
  const script = tracker.tokenizeScript("Hello, world — it's 2026.\nNext line");
  assert.deepEqual(
    script.tokens.map((token) => token.text),
    ["Hello,", "world", "—", "it's", "2026.", "Next", "line"],
  );
  assert.deepEqual(script.words, ["hello", "world", "its", "2026", "next", "line"]);
  assert.equal(script.tokens[2].wordIndex, -1);
  assert.equal(script.tokens[5].paragraph, 1);
  assert.deepEqual(script.wordTokens, [0, 1, 3, 4, 5, 6]);
});

test("withinOneEdit accepts single slips and rejects more", () => {
  assert.ok(tracker.withinOneEdit("conceived", "conceived"));
  assert.ok(tracker.withinOneEdit("conceived", "concieved") === false, "transposition is two edits");
  assert.ok(tracker.withinOneEdit("liberty", "libery"));
  assert.ok(tracker.withinOneEdit("liberty", "libertyy"));
  assert.ok(tracker.withinOneEdit("liberty", "libarty"));
  assert.ok(!tracker.withinOneEdit("liberty", "library"));
  assert.ok(tracker.withinOneEdit("nation", "notion"), "one substitution");
});

test("follows a clean read-through, word by word", () => {
  const script = tracker.tokenizeScript(SCRIPT);
  const t = new tracker.ScriptTracker(script.words);
  assert.equal(t.position, 0);
  // A lone first word is not enough evidence to move.
  t.feed("Good");
  assert.equal(t.position, 0);
  t.feed("Good evening");
  assert.equal(t.position, 2);
  speak(t, "Good evening everyone thank you for coming tonight");
  assert.equal(t.position, wordAt(script, "four"));
  speak(t, "Four score and seven years ago our fathers brought forth on this continent");
  assert.equal(t.position, wordAt(script, "a", wordAt(script, "continent")));
});

test("tolerates misrecognized and ad-libbed words", () => {
  const script = tracker.tokenizeScript(SCRIPT);
  const t = new tracker.ScriptTracker(script.words);
  t.anchor(wordAt(script, "four"));
  // "score" heard as "scored", "fathers" as "father's", plus an inserted "um".
  speak(t, "for scored and seven years ago um our father's brought forth");
  assert.equal(t.position, wordAt(script, "on"));
});

test("a partial last word counts as a prefix of the next script word", () => {
  const script = tracker.tokenizeScript(SCRIPT);
  const t = new tracker.ScriptTracker(script.words);
  t.anchor(wordAt(script, "four"));
  t.feed("four score and seven years ago our fath");
  assert.equal(t.position, wordAt(script, "brought"));
});

test("catches up when the speaker skips a sentence", () => {
  const script = tracker.tokenizeScript(SCRIPT);
  const t = new tracker.ScriptTracker(script.words);
  t.anchor(wordAt(script, "four"));
  speak(t, "Now we are engaged in a great civil war");
  assert.equal(t.position, wordAt(script, "testing"));
});

test("prefers the occurrence nearest the current position for repeated phrases", () => {
  const script = tracker.tokenizeScript(SCRIPT);
  const t = new tracker.ScriptTracker(script.words);
  // "that nation" appears in paragraphs 3 and 4; anchored in paragraph 4 it
  // should pick the later one.
  const laterThat = wordAt(script, "gave");
  t.anchor(laterThat);
  speak(t, "their lives that that nation might live");
  assert.equal(t.position, script.words.length);
});

test("does not move on transcripts that match nothing nearby", () => {
  const script = tracker.tokenizeScript(SCRIPT);
  const t = new tracker.ScriptTracker(script.words);
  t.anchor(wordAt(script, "four"));
  assert.equal(speak(t, "hang on let me find my glasses"), wordAt(script, "four"));
});

test("manual anchoring re-bases the search window", () => {
  const script = tracker.tokenizeScript(SCRIPT);
  const t = new tracker.ScriptTracker(script.words, { ahead: 10, back: 5 });
  // Far outside the window from position 0.
  speak(t, "final resting place for those who here gave");
  assert.equal(t.position, 0);
  t.anchor(wordAt(script, "final"));
  speak(t, "final resting place for those who here gave");
  assert.equal(t.position, wordAt(script, "their"));
});
