// The maths-engine behaviour the Calculator app depends on, pinned area by
// area: exact numbers, the spoken normaliser,
// parser precedence, simplification, solving with steps, rendering,
// derivatives and integrals, plotting, the stateful session, digit searches,
// and the advanced spoken-question router.
const test = require("node:test");
const assert = require("node:assert/strict");

const N = require("../.test-build/app/apps/calculator/math/math-number.js");
const { normalizeSpoken } = require("../.test-build/app/apps/calculator/math/normalizer.js");
const { parse, parseSpoken } = require("../.test-build/app/apps/calculator/math/parser.js");
const { evaluateExact, evaluateValue } = require("../.test-build/app/apps/calculator/math/evaluator.js");
const { simplify } = require("../.test-build/app/apps/calculator/math/simplifier.js");
const { plain } = require("../.test-build/app/apps/calculator/math/text-renderer.js");
const { solve, solutionHeadline } = require("../.test-build/app/apps/calculator/math/solver.js");
const { differentiate, integrateNumeric } = require("../.test-build/app/apps/calculator/math/derivative.js");
const { plot, axis } = require("../.test-build/app/apps/calculator/math/plotter.js");
const { MathSession, parseCommand } = require("../.test-build/app/apps/calculator/math/session.js");
const { fractionalDigits } = require("../.test-build/app/apps/calculator/math/constant-digits.js");
const { findDigits, countDigits } = require("../.test-build/app/apps/calculator/math/digit-search.js");
const { parseAdvanced, answerAdvanced } = require("../.test-build/app/apps/calculator/math/advanced.js");
const { longRunOffer } = require("../.test-build/app/apps/calculator/math/workload.js");
const { MathCoordinator } = require("../.test-build/app/apps/calculator/math/coordinator.js");

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

function evaluate(text, variables = {}) {
  const value = evaluateValue(parseSpoken(text), variables);
  assert.notEqual(value, null, `could not evaluate ${text}`);
  return value;
}

function rootValues(text) {
  const solution = solve(parseSpoken(text));
  assert.equal(solution.kind.kind, "roots", `expected roots for ${text}`);
  return solution.kind.roots.map((root) => N.doubleValue(evaluateExact(root)));
}

// ---------------------------------------------------------------------------
// Numbers

test("thirds sum to exactly one", () => {
  const third = N.rational(1, 3);
  const sum = N.add(N.add(third, third), third);
  assert.deepEqual(sum, N.integer(1));
});

test("rationals normalise", () => {
  assert.deepEqual(N.rational(2, 4), N.rational(1, 2));
  assert.deepEqual(N.rational(3, -6), { kind: "rational", n: -1, d: 2 });
  assert.deepEqual(N.rational(4, 2), N.integer(2));
});

test("decimal literals recover their fraction", () => {
  assert.deepEqual(N.fromDecimal(0.25), N.rational(1, 4));
  assert.deepEqual(N.fromDecimal(0.5), N.rational(1, 2));
  assert.equal(N.fromDecimal(Math.PI).kind, "real");
});

test("exact powers stay exact, irrational ones do not", () => {
  assert.deepEqual(N.raisedTo(N.integer(2), N.integer(10)), N.integer(1024));
  assert.deepEqual(N.raisedTo(N.rational(9, 4), N.rational(1, 2)), N.rational(3, 2));
  assert.equal(N.raisedTo(N.integer(2), N.rational(1, 2)).kind, "real");
});

test("overflow falls back to a real instead of trapping", () => {
  const huge = N.integer(Number.MAX_SAFE_INTEGER);
  assert.equal(N.multiply(huge, huge).kind, "real");
});

// ---------------------------------------------------------------------------
// Spoken normalisation

test("number words become digits, including compounds", () => {
  assert.equal(normalizeSpoken("twenty five"), "25");
  assert.equal(normalizeSpoken("one hundred forty four"), "144");
  assert.equal(normalizeSpoken("two thousand ten"), "2010");
  assert.equal(normalizeSpoken("three hundred and five"), "305");
});

test("operators and relations become symbols", () => {
  assert.equal(normalizeSpoken("two plus two"), "2 + 2");
  assert.equal(normalizeSpoken("x is less than or equal to five"), "x <= 5");
});

test("powers spoken every way", () => {
  assert.equal(normalizeSpoken("x squared"), "x^2");
  assert.equal(normalizeSpoken("two to the power of five"), "2^5");
  assert.equal(normalizeSpoken("x cubed"), "x^3");
  assert.equal(normalizeSpoken("two to the fifth"), "2^5");
});

test("command preambles are stripped", () => {
  assert.equal(normalizeSpoken("solve two x plus one equals five"), "2*x + 1 = 5");
  assert.equal(normalizeSpoken("what is two plus two"), "2 + 2");
});

// Always-on transcription commonly finalizes a valid equation together with
// the next conversational beat; that must not force an AI rewrite.
test("terminal conversational filler does not break parsing", () => {
  assert.equal(evaluate("3 x plus 1. Thank you.", { x: 2 }), 7);
});

test("implicit multiplication is made explicit", () => {
  assert.equal(normalizeSpoken("2x"), "2*x");
  assert.equal(normalizeSpoken("3(x+1)"), "3*(x+1)");
});

// The repair that stops `sqrt(x)` from becoming `sqr*t*(x)` once implicit
// multiplication has run over it.
test("function names survive implicit multiplication", () => {
  const normalized = normalizeSpoken("square root of sixteen");
  assert.ok(normalized.includes("sqrt"), normalized);
  assert.ok(!normalized.includes("sqr*t"), normalized);
  assert.ok(near(evaluate("square root of sixteen"), 4));
});

test("a full spoken quadratic parses to the right roots", () => {
  const roots = rootValues("two x squared plus three x minus five equals zero");
  assert.equal(roots.length, 2);
  assert.ok(near(roots[0], -2.5));
  assert.ok(near(roots[1], 1));
});

test("percent is a hundredth, not a remainder", () => {
  assert.ok(near(evaluate("15 percent of 240"), 36));
});

test("factorial spoken after the number", () => {
  assert.ok(near(evaluate("seven factorial"), 5040));
});

test("fractions spoken as words", () => {
  assert.ok(near(evaluate("three over four"), 0.75));
  assert.ok(near(evaluate("two thirds"), 2 / 3));
});

// ---------------------------------------------------------------------------
// Parser

test("precedence: multiplication before addition", () => {
  assert.ok(near(evaluate("2 + 3 * 4"), 14));
});

// `-x^2` is `-(x^2)` — the convention every textbook and every other
// calculator uses. Getting it backwards silently changes the answer.
test("unary minus binds looser than a power", () => {
  assert.ok(near(evaluate("-3^2"), -9));
});

test("powers are right associative", () => {
  assert.ok(near(evaluate("2^3^2"), 512));
});

test("negative exponents parse", () => {
  assert.ok(near(evaluate("2^-1"), 0.5));
});

test("absolute value with pipes", () => {
  assert.ok(near(evaluate("|0 - 5|"), 5));
});

test("modulo", () => {
  assert.ok(near(evaluate("10 % 3"), 1));
  assert.ok(near(evaluate("-1 % 3"), 2));
});

test("adjacent single letters are a product, not one long name", () => {
  assert.ok(near(evaluate("xy", { x: 3, y: 4 }), 12));
});

test("unbalanced brackets are reported, not guessed past", () => {
  assert.throws(() => parse("(1 + 2"));
});

test("chained comparisons are refused rather than half-honoured", () => {
  assert.throws(() => parse("1 < x < 5"));
});

test("a pathological nest fails instead of blowing the stack", () => {
  const nested = "(".repeat(500) + "1" + ")".repeat(500);
  assert.throws(() => parse(nested));
});

// ---------------------------------------------------------------------------
// Simplifier and renderer

const simplified = (text) => plain(simplify(parse(text)));

test("like terms collect", () => {
  assert.equal(simplified("2*x + 3*x"), "5*x");
});

test("identity elements disappear", () => {
  assert.equal(simplified("x + 0"), "x");
  assert.equal(simplified("1 * x"), "x");
  assert.equal(simplified("x^1"), "x");
});

test("powers of the same base combine", () => {
  assert.equal(simplified("x * x^2"), "x^3");
});

// This is what keeps `sqrt(2)` symbolic while `sqrt(9)` becomes 3.
test("irrational roots stay symbolic while perfect ones fold", () => {
  assert.equal(simplified("sqrt(9)"), "3");
  assert.equal(simplified("sqrt(2)"), "sqrt(2)");
});

test("division renders as a fraction, not a negative power", () => {
  assert.equal(plain(simplify(parse("2 / x"))), "2/x");
});

test("subtraction renders as a minus, not plus-negative", () => {
  const text = plain(parse("x - 3"));
  assert.ok(text.includes("- 3"), text);
  assert.ok(!text.includes("+ -"), text);
});

// ---------------------------------------------------------------------------
// Solver

test("linear equations solve exactly", () => {
  const solution = solve(parseSpoken("2x + 7 = 19"));
  assert.equal(solutionHeadline(solution), "x = 6");
});

test("linear with a fractional answer stays exact", () => {
  const solution = solve(parseSpoken("2x = 3"));
  assert.equal(solutionHeadline(solution), "x = 3/2");
});

test("quadratic with two rational roots", () => {
  const roots = rootValues("x^2 - 5x + 6 = 0");
  assert.ok(near(roots[0], 2));
  assert.ok(near(roots[1], 3));
});

test("quadratic with a repeated root reports it once", () => {
  assert.equal(rootValues("x^2 - 2x + 1 = 0").length, 1);
});

test("quadratic with no real roots", () => {
  const solution = solve(parseSpoken("x^2 + 1 = 0"));
  assert.equal(solutionHeadline(solution), "No real solution");
});

// (−b ± √D) / 2a is the exact answer; collapsing it to decimals throws away
// information the wearer may want to see.
test("irrational quadratic roots keep their radical", () => {
  const solution = solve(parseSpoken("x^2 - 2 = 0"));
  assert.equal(solution.kind.kind, "roots");
  assert.equal(solution.kind.roots.length, 2);
  assert.ok(solutionHeadline(solution).includes("sqrt"), solutionHeadline(solution));
  const numeric = solution.kind.roots
    .map((root) => N.doubleValue(evaluateExact(root)))
    .sort((a, b) => a - b);
  assert.ok(near(numeric[0], -Math.SQRT2));
  assert.ok(near(numeric[1], Math.SQRT2));
});

test("cubic via the rational root theorem", () => {
  const roots = rootValues("x^3 - 6x^2 + 11x - 6 = 0");
  assert.equal(roots.length, 3);
  assert.ok(near(roots[0], 1) && near(roots[1], 2) && near(roots[2], 3));
});

test("an identity and a contradiction are distinguished", () => {
  assert.equal(solve(parseSpoken("x = x")).kind.kind, "identity");
  assert.equal(solve(parseSpoken("0 = 1")).kind.kind, "contradiction");
});

test("a plain expression evaluates instead of solving", () => {
  const solution = solve(parseSpoken("2 + 2"));
  assert.equal(solution.kind.kind, "value");
  assert.equal(solutionHeadline(solution), "4");
});

// The single most common mistake in this whole topic, so it gets its own
// visible step — and its own test.
test("dividing an inequality by a negative flips it", () => {
  const solution = solve(parseSpoken("-2x < 6"));
  assert.equal(solution.kind.kind, "interval");
  assert.equal(solution.kind.relation, ">");
});

test("transcendental equations fall back to a numeric search", () => {
  const solution = solve(parseSpoken("sin(x) = 0"));
  assert.equal(solution.kind.kind, "roots");
  const values = solution.kind.roots.map((root) => N.doubleValue(evaluateExact(root)));
  assert.ok(values.some((value) => near(value, 0, 1e-4)));
});

// Bisection happily converges onto tan's asymptote; the residual check is
// what rejects it.
test("a pole is not mistaken for a root", () => {
  const solution = solve(parseSpoken("tan(x) = 0"));
  assert.equal(solution.kind.kind, "roots");
  for (const root of solution.kind.roots) {
    const value = N.doubleValue(evaluateExact(root));
    assert.ok(Math.abs(Math.tan(value)) < 1e-4, `tan(${value}) is not near zero`);
  }
});

test("a linear solve records usable steps", () => {
  const solution = solve(parseSpoken("2x + 7 = 19"));
  assert.ok(solution.steps.length >= 2);
  assert.ok(solution.steps.every((step) => step.title.length > 0 && step.detail.length > 0));
});

test("a quadratic explains its discriminant", () => {
  const solution = solve(parseSpoken("x^2 - 5x + 6 = 0"));
  assert.ok(solution.steps.some((step) => step.title === "Discriminant"));
});

// ---------------------------------------------------------------------------
// Derivatives and integrals

const derivativeText = (text, variable = "x") => plain(differentiate(parseSpoken(text), variable));

test("power rule", () => {
  assert.equal(derivativeText("x^2"), "2*x");
});

test("chain rule through a function", () => {
  assert.equal(derivativeText("sin(2*x)"), "2*cos(2*x)");
});

test("derivatives agree with a finite difference", () => {
  for (const expression of ["x^3 + 2*x", "sin(x) * x", "exp(x) / (x + 2)", "ln(x^2 + 1)"]) {
    const parsed = parseSpoken(expression);
    const derived = differentiate(parsed, "x");
    for (const x of [0.5, 1.0, 2.0]) {
      const h = 1e-6;
      const left = evaluateValue(parsed, { x: x - h });
      const right = evaluateValue(parsed, { x: x + h });
      const expected = (right - left) / (2 * h);
      const actual = evaluateValue(derived, { x });
      assert.ok(near(actual, expected, 1e-4), `${expression} at ${x}: ${actual} vs ${expected}`);
    }
  }
});

test("definite integrals of known areas", () => {
  assert.ok(near(integrateNumeric(parseSpoken("x^2"), "x", 0, 3), 9, 1e-6));
  assert.ok(near(integrateNumeric(parseSpoken("sin(x)"), "x", 0, Math.PI), 2, 1e-6));
});

test("reversing the limits negates the result", () => {
  const forward = integrateNumeric(parseSpoken("x^2"), "x", 0, 3);
  const backward = integrateNumeric(parseSpoken("x^2"), "x", 3, 0);
  assert.ok(near(forward, -backward, 1e-9));
});

// ---------------------------------------------------------------------------
// Plotter

test("a parabola samples and autoscales", () => {
  const graph = plot([parseSpoken("x^2")]);
  assert.equal(graph.plots.length, 1);
  assert.ok(graph.plots[0].segments.length >= 1);
  assert.ok(graph.viewport.yMax > 0);
});

// The single most recognisable "bad graphing app" artefact: a vertical line
// at every asymptote.
test("tan breaks into segments at its asymptotes", () => {
  const graph = plot([parseSpoken("tan(x)")]);
  assert.ok(graph.plots[0].segments.length > 3);
});

test("a function with a restricted domain only plots where it is defined", () => {
  const graph = plot([parseSpoken("sqrt(x)")]);
  for (const segment of graph.plots[0].segments) {
    for (const point of segment.points) {
      assert.ok(point.x >= 0);
    }
  }
});

test("axis ticks land on round numbers", () => {
  const ticks = axis(-10, 10).ticks;
  assert.ok(ticks.includes(0));
  assert.ok(ticks.every((tick) => near(tick % 2, 0, 1e-9) || near(Math.abs(tick % 2), 2, 1e-9)));
});

test("roots are marked on the graph", () => {
  const graph = plot([parseSpoken("x^2 - 4")]);
  const markers = graph.plots[0].markers;
  assert.ok(markers.some((marker) => marker.kind === "root" && near(marker.point.x, 2, 1e-3)));
  assert.ok(markers.some((marker) => marker.kind === "root" && near(marker.point.x, -2, 1e-3)));
});

// ---------------------------------------------------------------------------
// Session and follow-ups

test("follow-up commands are recognised, bare and with it", () => {
  for (const utterance of ["graph it", "graph", "plot it", "show the graph"]) {
    assert.equal(parseCommand(utterance).kind, "graph", utterance);
  }
  for (const utterance of ["explain it", "explain", "show the steps", "step by step"]) {
    assert.equal(parseCommand(utterance).kind, "explain", utterance);
  }
  for (const utterance of ["solve it", "solve", "what is the answer"]) {
    assert.equal(parseCommand(utterance).kind, "restate", utterance);
  }
});

test("ordinary conversation is not treated as math", () => {
  assert.equal(parseCommand("I'll see you at four"), null);
  assert.equal(parseCommand("that was a lovely dinner"), null);
});

test("solve then graph then explain, without restating the problem", () => {
  const session = new MathSession();
  const solved = session.solve("x^2 - 4 = 0");
  assert.equal(solved.payload.kind, "solution");

  const graphed = session.graph();
  assert.equal(graphed.payload.kind, "graph");

  const explained = session.explain();
  assert.equal(explained.payload.kind, "step");
  assert.equal(explained.payload.index, 0);
});

// A wearer scrolling past the end should land on the answer and stay there,
// not loop back to the start.
test("stepping clamps at both ends instead of wrapping", () => {
  const session = new MathSession();
  session.solve("2x + 7 = 19");
  session.explain();
  let last = null;
  for (let step = 0; step < 20; step++) last = session.execute({ kind: "nextStep" });
  assert.equal(last.payload.index, last.payload.total - 1);
  for (let step = 0; step < 20; step++) last = session.execute({ kind: "previousStep" });
  assert.equal(last.payload.index, 0);
});

test("follow-ups before a problem fail with a usable message", () => {
  const session = new MathSession();
  const result = session.graph();
  assert.equal(result.payload.kind, "failure");
  assert.equal(result.headline, "No problem yet");
});

test("a misheard problem reports what was said, not the normalised form", () => {
  const session = new MathSession();
  const result = session.solve("two plus plus plus");
  assert.equal(result.payload.kind, "failure");
  assert.ok(result.detail.includes("two plus plus plus"), result.detail);
});

test("derivative as a follow-up", () => {
  const session = new MathSession();
  session.solve("x^3");
  const result = session.differentiate(null);
  assert.equal(result.headline, "d/dx = 3*x^2");
});

test("trig in degrees is honoured", () => {
  const session = new MathSession(true);
  const result = session.solve("sin(90)");
  assert.equal(result.headline, "1");
});

// ---------------------------------------------------------------------------
// Constants and digit search

// The position convention: decimal places after the point, 1-based. The
// first `11` in π is at 94–95.
test("the first 11 in pi is at places 94 to 95", () => {
  const outcome = findDigits("11", "pi", 1);
  assert.equal(outcome.kind, "found");
  assert.equal(outcome.match.start, 94);
  assert.equal(outcome.match.end, 95);
});

test("pi opens with the digits everyone knows", () => {
  assert.ok(fractionalDigits("pi", 10).startsWith("1415926535"));
  assert.ok(fractionalDigits("e", 10).startsWith("7182818284"));
  assert.ok(fractionalDigits("sqrt2", 10).startsWith("4142135623"));
  assert.ok(fractionalDigits("phi", 10).startsWith("6180339887"));
});

// Overlapping matches count: "111" contains "11" twice.
test("digit counting counts overlaps", () => {
  const counted = countDigits("1", "pi", 100);
  assert.ok(counted.occurrences >= 8, String(counted.occurrences));
  assert.equal(counted.searchedDigits, 100);
});

// ---------------------------------------------------------------------------
// Advanced router

test("number theory questions route and answer", () => {
  assert.equal(answerAdvanced(parseAdvanced("is 91 prime")).headline, "91 is not prime");
  assert.equal(answerAdvanced(parseAdvanced("factor 360")).headline, "360 = 2^3 × 3^2 × 5");
  assert.equal(answerAdvanced(parseAdvanced("gcd of 12 and 18")).headline, "gcd(12, 18) = 6");
  assert.equal(answerAdvanced(parseAdvanced("what is 5 choose 2")).headline, "C(5, 2) = 10");
});

test("calculus questions route and answer", () => {
  assert.equal(answerAdvanced(parseAdvanced("the integral of x squared from 0 to 3")).headline, "∫ = 9");
  assert.equal(answerAdvanced(parseAdvanced("limit of sin(x)/x as x approaches 0")).headline, "limit = 1");
});

// A trig equation's right answer is the FAMILY, not the twelve roots that
// happen to fall in a search window.
test("trig equations answer with solution families", () => {
  const answer = answerAdvanced(parseAdvanced("solve sin x = 0.5"));
  assert.ok(answer.headline.includes("pi/6"), answer.headline);
  assert.ok(answer.headline.includes("·n"), answer.headline);
});

test("geometry questions route and answer", () => {
  const circle = answerAdvanced(parseAdvanced("area of a circle with radius 3"));
  assert.ok(circle.headline.includes("28.27"), circle.headline);
  const triangle = answerAdvanced(parseAdvanced("triangle with sides 3 4 5"));
  assert.ok(triangle.headline.includes("right"), triangle.headline);
});

test("digit questions route through the advanced router", () => {
  const found = answerAdvanced(parseAdvanced("where does 11 first appear in pi"));
  assert.ok(found.headline.includes("94"), found.headline);
  // "area of a circle" contains pi implicitly and must NOT land here.
  assert.equal(parseAdvanced("area of a circle with radius 2").kind, "shapeArea");
});

// A six-digit run needs ~10^6 places; the fast pass cannot settle it, so the
// answer must be honest about depth and carry a long-run offer.
test("a deep digit search reports its depth and offers a longer run", () => {
  const answer = answerAdvanced(parseAdvanced("where does 867530 appear in pi"));
  assert.ok(answer.headline.includes("Not in the first"), answer.headline);
  assert.notEqual(answer.unresolvedWorkload, null);
  const offer = longRunOffer(answer.unresolvedWorkload, "test");
  assert.notEqual(offer, null);
  assert.equal(offer.depth, 1_000_000);
  assert.ok(offer.estimatedSeconds > 0);
});

// ---------------------------------------------------------------------------
// Coordinator

test("coordinator follows up on the standing problem", () => {
  const coordinator = new MathCoordinator();
  const solved = coordinator.run("solve", "x^2 - 4 = 0");
  assert.equal(solved.kind, "value");

  const graphed = coordinator.run("graph", "");
  assert.equal(graphed.kind, "value");
  assert.notEqual(coordinator.lastGraph, null);

  const explained = coordinator.run("explain", "");
  assert.equal(explained.kind, "value");
  assert.deepEqual(coordinator.stepPosition, { index: 0, total: coordinator.explanationSteps.length });

  const restated = coordinator.run("solve", "");
  assert.equal(restated.kind, "value");
  assert.equal(coordinator.lastGraph, null);
});

test("coordinator surfaces a long-run offer for deep searches", async () => {
  const coordinator = new MathCoordinator();
  const outcome = await coordinator.answerSpoken("where does 314159 appear in pi");
  assert.equal(outcome.kind, "value");
  assert.notEqual(coordinator.pendingLongRun, null);
  // Declining leaves the shallow answer standing.
  coordinator.declineLongRun();
  assert.equal(coordinator.pendingLongRun, null);
});

test("long-run accept phrases are recognised only while an offer stands", async () => {
  const coordinator = new MathCoordinator();
  assert.equal(coordinator.handleLongRunUtterance("keep going"), null);
  await coordinator.answerSpoken("where does 314159 appear in pi");
  assert.notEqual(coordinator.pendingLongRun, null);
  const declined = coordinator.handleLongRunUtterance("never mind");
  assert.equal(declined.kind, "failure");
  assert.equal(coordinator.pendingLongRun, null);
});

test("the coordinator's gesture contract walks steps and clears", () => {
  const coordinator = new MathCoordinator();
  coordinator.run("solve", "2x + 7 = 19");
  coordinator.run("explain", "");
  const forward = coordinator.handleRingAction("forward");
  assert.equal(forward.kind, "value");
  assert.equal(coordinator.stepPosition.index, 1);
  const cleared = coordinator.handleRingAction("exit");
  assert.equal(cleared.kind, "value");
  assert.equal(coordinator.hasProblem, false);
});
