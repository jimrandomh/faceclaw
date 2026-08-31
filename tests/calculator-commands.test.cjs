// These pin the Calculator app's own decisions: which utterances are
// commands, which unprompted room speech is worth answering, and how the
// modes map onto the shared maths session.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CALCULATOR_MODES,
  cycleMode,
  isDictationCancellation,
  isWorthAnswering,
  modeBranch,
  modeCommand,
  modeSpokenCommands,
} = require("../.test-build/app/apps/calculator/calculator-commands.js");

// Both the bare verb and the "it" form, because a wearer shown "Graph" says
// both — and leaving the bare form out makes the feature look broken in
// exactly the case the user was taught.
test("every advertised command is recognised", () => {
  for (const mode of CALCULATOR_MODES) {
    for (const command of modeSpokenCommands(mode)) {
      assert.equal(modeCommand(command), mode, `"${command}" is advertised for ${mode} but is not recognised`);
    }
  }
});

test("commands survive punctuation and case", () => {
  assert.equal(modeCommand("Solve it."), "solve");
  assert.equal(modeCommand("  GRAPH IT  "), "graph");
  assert.equal(modeCommand("Explain?"), "explain");
});

test("listening cancellation commands are exact", () => {
  for (const command of ["cancel", "Cancel listening.", "STOP LISTENING", "never mind"]) {
    assert.ok(isDictationCancellation(command), command);
  }
  assert.ok(!isDictationCancellation("cancel the denominator"));
  assert.ok(!isDictationCancellation("I never mind the rain"));
});

// A substring test would turn ordinary conversation into a command. This is
// the sentence that motivated matching the whole utterance.
test("conversation containing a command word is not a command", () => {
  assert.equal(modeCommand("I need to solve this with the tax people"), null);
  assert.equal(modeCommand("the graph in the report was wrong"), null);
});

// In continuous mode the app sees every finalized utterance in the room.
// Without a gate, every sentence becomes a failed calculation.
test("ordinary speech is not answered unprompted", () => {
  assert.ok(!isWorthAnswering("I'll see you at four"));
  assert.ok(!isWorthAnswering("that was a lovely dinner"));
});

test("real questions and commands are answered unprompted", () => {
  assert.ok(isWorthAnswering("what is two plus two"));
  assert.ok(isWorthAnswering("solve 2x + 7 = 19"));
  assert.ok(isWorthAnswering("graph it"));
});

test("every mode maps to a branch mode", () => {
  assert.deepEqual(
    new Set(CALCULATOR_MODES.map(modeBranch)),
    new Set(["solve", "explain", "graph"]),
  );
});

test("scrolling cycles the modes in both directions", () => {
  assert.equal(cycleMode("solve", true), "explain");
  assert.equal(cycleMode("explain", true), "graph");
  assert.equal(cycleMode("graph", true), "solve");
  assert.equal(cycleMode("solve", false), "graph");
});
