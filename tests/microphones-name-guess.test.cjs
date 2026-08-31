// Introduction-based speaker naming: spoken "I'm Alice" / "this is Bob"
// shapes rename auto-numbered speakers, with guardrails against common
// non-name continuations.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  inferIntroducedName,
  isGenericSpeakerName,
  pendingApplies,
  PENDING_INTRODUCTION_TTL_MS,
} = require("../.test-build/app/apps/microphones/name-guess.js");

test("self-introductions are recognized", () => {
  assert.deepEqual(inferIntroducedName("Hi, I'm Alice."), { name: "Alice", kind: "self" });
  assert.deepEqual(inferIntroducedName("Hello everyone, my name is Bob Smith and I work here."), {
    name: "Bob Smith",
    kind: "self",
  });
  assert.deepEqual(inferIntroducedName("You can call me Kai."), { name: "Kai", kind: "self" });
  assert.deepEqual(inferIntroducedName("Good morning, this is Alice speaking."), {
    name: "Alice",
    kind: "self",
  });
});

test("third-party introductions are recognized", () => {
  assert.deepEqual(inferIntroducedName("Everyone, this is Bob."), { name: "Bob", kind: "third-party" });
  assert.deepEqual(inferIntroducedName("Come meet Carol!"), { name: "Carol", kind: "third-party" });
  assert.deepEqual(inferIntroducedName("Her name is Dana."), { name: "Dana", kind: "third-party" });
});

test("common non-name continuations do not trigger", () => {
  assert.equal(inferIntroducedName("I'm not sure about that."), null);
  assert.equal(inferIntroducedName("I'm So excited."), null);
  assert.equal(inferIntroducedName("I'm Sorry about earlier."), null);
  assert.equal(inferIntroducedName("this is Fine, thanks"), null);
  assert.equal(inferIntroducedName("I'm Going to the store."), null);
});

test("states, feelings, and progressive verbs are rejected even capitalized", () => {
  assert.equal(inferIntroducedName("I'm Hungry, let's eat."), null);
  assert.equal(inferIntroducedName("I'm Wanting to leave soon."), null);
  assert.equal(inferIntroducedName("I'm Exhausted after that."), null);
  assert.equal(inferIntroducedName("I'm Heading out now."), null);
  assert.equal(inferIntroducedName("I'm Nervous about the demo."), null);
  assert.equal(inferIntroducedName("I'm Married, by the way."), null);
  assert.equal(inferIntroducedName("this is Ridiculous... wait no, this is Awesome"), null);
  assert.equal(inferIntroducedName("I'm Waiting outside."), null);
});

test("unusual but real names still pass the heuristic tier", () => {
  // The regex tier stays permissive here; the on-device LLM tier gets the
  // final say when it's available.
  assert.deepEqual(inferIntroducedName("Hi, I'm Ming."), { name: "Ming", kind: "self" });
  assert.deepEqual(inferIntroducedName("I'm Priya from the design team."), {
    name: "Priya",
    kind: "self",
  });
});

test("lowercase candidates are rejected (ASR proper nouns are capitalized)", () => {
  assert.equal(inferIntroducedName("i'm alice"), null);
});

test("generic speaker names are detected", () => {
  assert.equal(isGenericSpeakerName("Speaker 3"), true);
  assert.equal(isGenericSpeakerName("Alice"), false);
  assert.equal(isGenericSpeakerName("Speaker three"), false);
});

test("pending third-party introduction applies to the right person", () => {
  const pending = { name: "Bob", bySpeakerId: 1, atMs: 1000 };
  assert.equal(pendingApplies(pending, 2, "Speaker 2", 2000), true);
  // Not the introducer themselves.
  assert.equal(pendingApplies(pending, 1, "Speaker 1", 2000), false);
  // Never overwrites a real name.
  assert.equal(pendingApplies(pending, 2, "Dana", 2000), false);
  // Expires.
  assert.equal(pendingApplies(pending, 2, "Speaker 2", 1000 + PENDING_INTRODUCTION_TTL_MS + 1), false);
});
