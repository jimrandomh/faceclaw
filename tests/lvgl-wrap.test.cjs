// EvenHub text-container wrapping (app/graphics/lvgl-wrap.ts), against what
// stock firmware 2.2.9.22 drew in the g2-firmware-emulator: spaces are kept
// everywhere, including ones that overflow onto a soft-wrapped line.
const test = require("node:test");
const assert = require("node:assert/strict");

const { wrapLvglText } = require("../.test-build/app/graphics/lvgl-wrap.js");

// The stock 20px font's advances for these: H 12px, E 11px, space 5px.
const ADVANCES = { H: 12, E: 11, " ": 5 };
const advance = (cp) => ADVANCES[String.fromCodePoint(cp)] ?? 10;

test("indentation after a newline and at the start is kept (Iris Pro's icon-clearing indent)", () => {
  assert.deepEqual(wrapLvglText(" \n           R E C O R D", 248, advance), [" ", "           R E C O R D"]);
  assert.deepEqual(wrapLvglText("AB\n    CD", 248, advance), ["AB", "    CD"]);
  assert.deepEqual(wrapLvglText("    EF", 248, advance), ["    EF"]);
});

test("spaces that overflow a line start the next one (emulator Q3)", () => {
  const text = "HHHHHHHH    EEEE";
  assert.deepEqual(wrapLvglText(text, 100, advance), ["HHHHHHHH", "    EEEE"]);
  assert.deepEqual(wrapLvglText(text, 110, advance), ["HHHHHHHH  ", "  EEEE"]);
  assert.deepEqual(wrapLvglText(text, 120, advance), ["HHHHHHHH    ", "EEEE"]);
});

test("a word that overflows wraps after the last space or hyphen", () => {
  assert.deepEqual(wrapLvglText("HH EEEEEEEE", 100, advance), ["HH ", "EEEEEEEE"]);
  assert.deepEqual(wrapLvglText("HH-EEEEEEEE", 100, advance), ["HH-", "EEEEEEEE"]);
});

test("a run with no break opportunity breaks before the overflowing character", () => {
  assert.deepEqual(wrapLvglText("HHHHHHHHHH", 50, advance), ["HHHH", "HHHH", "HH"]);
  // A character wider than the line still gets one to itself.
  assert.deepEqual(wrapLvglText("HH", 5, advance), ["H", "H"]);
});
