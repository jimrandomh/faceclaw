// EvenHub text-container wrapping (app/graphics/lvgl-wrap.ts): pretext's
// breaks, except that leading spaces survive at the start of the text and
// after '\n' — apps indent with them to clear icons placed beside the text.
const test = require("node:test");
const assert = require("node:assert/strict");

const { wrapLvglText } = require("../.test-build/app/graphics/lvgl-wrap.js");

// Spaces are 4px like the stock 20px font; everything else 10px.
const fixed = (cp) => (cp === 32 ? 4 : 10);

test("indentation after a newline is kept (Iris Pro's icon-clearing indent)", () => {
  const content = " \n           R E C O R D\n           Conversation";
  const lines = wrapLvglText(content, 248, fixed);
  assert.deepEqual(lines, [" ", "           R E C O R D", "           Conversation"]);
});

test("indentation at the very start of the text is kept", () => {
  assert.deepEqual(wrapLvglText("      55°", 248, fixed), ["      55°"]);
});

test("a soft-wrapped continuation line drops its leading spaces", () => {
  // "aaaa" (40px) fits; the space after it overflows at width 40 and is
  // discarded, and the next space would lead the continuation line.
  assert.deepEqual(wrapLvglText("aaaa  bbbb", 40, fixed), ["aaaa", "bbbb"]);
  // Wrapping at an earlier break opportunity.
  assert.deepEqual(wrapLvglText("aa bb cc", 54, fixed), ["aa bb", "cc"]);
});

test("unindented text breaks exactly where pretext's measureTextWrap says", async () => {
  const pretext = await import("@evenrealities/pretext");
  const advance = (a, b) => (b ? pretext.getTextWidth(String.fromCodePoint(a, b)) - pretext.getTextWidth(String.fromCodePoint(b)) : pretext.getTextWidth(String.fromCodePoint(a)));
  const samples = [
    "Market moving from feature flex to everyday integration",
    "No one owns human, calm intelligence\nConversation likely becomes next differentiation layer",
    "Supercalifragilisticexpialidocious-and-then-some words that will not fit on one line at all",
    "short\n\nlines\nhere",
  ];
  for (const text of samples) {
    for (let width = 40; width <= 560; width += 7) {
      const ours = wrapLvglText(text, width, advance);
      assert.equal(ours.length, pretext.measureTextWrap(text, width).lineCount, `${JSON.stringify(text)} at ${width}px`);
    }
  }
});
