const test = require("node:test");
const assert = require("node:assert/strict");
const { drawHealthCard } = require("../.test-build/app/health/health-card.js");
const { dailySummary } = require("../.test-build/app/health/health-derive.js");

function render(data) {
  const draws = [];
  const font = { lineHeight: 21, measureText: (text) => text.length * 10 };
  const image = { width: 288, height: 144, drawText(font, x, y, text) {
    assert.ok(x >= 0 && x + font.measureText(text) <= 288, `horizontal overflow: ${text}`);
    assert.ok(y >= 0 && y + font.lineHeight <= 144, `vertical overflow: ${text}`);
    draws.push(text);
  } };
  drawHealthCard(image, data, font, font);
  return draws;
}

test("health card distinguishes an observed zero from missing metrics", () => {
  const summary = dailySummary([], [], 0);
  const text = render({ kind: "live", summary, hasSteps: true, hasCalories: false });
  assert.equal(text.filter((value) => value === "0").length, 1);
  assert.equal(text.filter((value) => value === "--").length, 5);
});

test("health card prominently labels fixtures without displaying sample measurements", () => {
  const text = render({ kind: "fixture" });
  assert.ok(text.includes("Sample data"));
  assert.ok(!text.includes("HR avg"));
  for (const kind of ["empty", "error"]) render({ kind });
});
