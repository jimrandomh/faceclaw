// Solves what a person actually asks a calculator, in the order of
// likelihood: evaluate an arithmetic expression, solve a linear or quadratic
// equation, find polynomial roots, or fall back to a numeric search.
//
// Every branch records SolutionSteps as it goes, because "explain it" is a
// first-class feature here rather than a reconstruction after the fact — a
// post-hoc explanation of a numeric root search would be fiction.

import {
  type MathExpression,
  type MathRelation,
  ZERO,
  addExpr,
  divideExpr,
  expressionEquals,
  flippedRelation,
  fn,
  int,
  multiplyExpr,
  negate,
  num,
  numberValue,
  relation as relationExpr,
  spokenRelation,
  subtractExpr,
  variable as variableExpr,
  variablesOf,
} from "./expression";
import {
  type MathNumber,
  add,
  describeNumber,
  doubleValue,
  fromDecimal,
  integer,
  isExact,
  isNegative,
  isZero,
  multiply,
  negated,
  divide as divideNumber,
  raisedTo,
  rational,
  real,
  subtract,
} from "./math-number";
import { type EvaluatorContext, evaluateExact, evaluateValue, radiansContext } from "./evaluator";
import { simplify } from "./simplifier";
import { Polynomial } from "./polynomial";
import { plain, renderNumber } from "./text-renderer";

// ---------------------------------------------------------------------------
// Steps

/**
 * One line of "explain it". Recorded by the solver as it works rather than
 * reconstructed afterwards.
 */
export type SolutionStep = {
  id: number;
  /** Short imperative title — what was done ("Divide by 2"). */
  title: string;
  /** The expression AFTER this step. */
  expression: MathExpression;
  /** Plain-language reason, shown under the title. */
  detail: string;
};

export function stepPlain(step: SolutionStep): string {
  return plain(step.expression);
}

export class SolutionStepRecorder {
  readonly steps: SolutionStep[] = [];

  add(title: string, expression: MathExpression, detail: string): void {
    // Collapse a step that changed nothing — "Simplify: 2x + 1" following
    // "Start: 2x + 1" is noise that makes a short solve look laborious.
    const last = this.steps[this.steps.length - 1];
    if (last && expressionEquals(last.expression, expression)) return;
    this.steps.push({ id: this.steps.length, title, expression, detail });
  }
}

// ---------------------------------------------------------------------------
// Solution

export type MathSolutionKind =
  /** A finite set of values for the unknown. */
  | { kind: "roots"; roots: MathExpression[] }
  /** The relation holds for every value (`x = x`). */
  | { kind: "identity" }
  /** It holds for none (`0 = 1`). */
  | { kind: "contradiction" }
  /** A single evaluated value — the answer to "what is 2+2". */
  | { kind: "value"; value: MathExpression }
  /** Simplified but not solved (no unknown to solve for). */
  | { kind: "simplified"; value: MathExpression }
  /** An inequality's solution interval. */
  | {
      kind: "interval";
      lower: MathExpression | null;
      upper: MathExpression | null;
      relation: MathRelation;
    };

export type MathSolution = {
  kind: MathSolutionKind;
  variable: string | null;
  steps: SolutionStep[];
  /**
   * The input as the engine understood it, so a wearer can confirm the
   * machine heard the same problem they said.
   */
  restatement: MathExpression;
};

/** The short line the glasses show. */
export function solutionHeadline(solution: MathSolution): string {
  const kind = solution.kind;
  switch (kind.kind) {
    case "roots":
      if (kind.roots.length === 0) return "No real solution";
      return kind.roots.map((root) => `${solution.variable ?? "x"} = ${plain(root)}`).join(",  ");
    case "identity":
      return "True for every value";
    case "contradiction":
      return "No solution";
    case "value":
      return plain(kind.value);
    case "simplified":
      return plain(kind.value);
    case "interval":
      return intervalText(kind.lower, kind.upper, kind.relation, solution.variable);
  }
}

function intervalText(
  lower: MathExpression | null,
  upper: MathExpression | null,
  relation: MathRelation,
  variable: string | null,
): string {
  const name = variable ?? "x";
  if (lower && !upper) return `${name} ${relation} ${plain(lower)}`;
  if (upper && !lower) return `${name} ${relation} ${plain(upper)}`;
  if (lower && upper) return `${plain(lower)} < ${name} < ${plain(upper)}`;
  return `all ${name}`;
}

// ---------------------------------------------------------------------------
// Solver

export function solve(
  expression: MathExpression,
  solveFor: string | null = null,
  context: EvaluatorContext = radiansContext(),
): MathSolution {
  const steps = new SolutionStepRecorder();
  const simplified = simplify(expression);

  if (simplified.type !== "relation") {
    return evaluateExpression(simplified, expression, context, steps);
  }

  const relation = simplified.relation;
  const lhs = simplified.lhs;
  const rhs = simplified.rhs;

  const variable = solveFor ?? variablesOf(simplified)[0] ?? null;
  if (!variable) {
    // No unknown: this is a claim to check, not an equation to solve.
    return checkClaim(relation, lhs, rhs, expression, context);
  }

  steps.add("Start", simplified, `Solve for ${variable}.`);

  // Move everything to the left: lhs - rhs (relation) 0.
  const difference = simplify(subtractExpr(lhs, rhs));
  if (!(rhs.type === "number" && isZero(rhs.value))) {
    steps.add(
      "Move every term to one side",
      relationExpr(relation, difference, ZERO),
      `Subtract ${plain(rhs)} from both sides.`,
    );
  }

  const polynomial = Polynomial.extract(difference, variable);
  if (!polynomial) {
    return solveNumerically(difference, relation, variable, expression, context, steps);
  }

  if (relation !== "=") {
    return solveInequality(polynomial, relation, variable, expression, steps);
  }

  switch (polynomial.degree) {
    case 0: {
      // No unknown survived: either always true or never.
      const constant = polynomial.at(0);
      const kind: MathSolutionKind = isZero(constant) ? { kind: "identity" } : { kind: "contradiction" };
      steps.add(
        isZero(constant) ? "Every value works" : "No value works",
        relationExpr("=", num(constant), ZERO),
        isZero(constant)
          ? `${variable} cancelled out and the statement is true.`
          : `${variable} cancelled out and ${describeNumber(constant)} ≠ 0.`,
      );
      return { kind, variable, steps: steps.steps, restatement: simplified };
    }

    case 1:
      return solveLinear(polynomial, variable, simplified, steps);

    case 2:
      return solveQuadratic(polynomial, variable, simplified, steps);

    default:
      return solvePolynomial(polynomial, variable, simplified, steps);
  }
}

// ---------------------------------------------------------------------------
// Plain expressions

function evaluateExpression(
  simplified: MathExpression,
  original: MathExpression,
  context: EvaluatorContext,
  steps: SolutionStepRecorder,
): MathSolution {
  steps.add("Start", original, "Evaluate the expression.");
  if (!expressionEquals(simplified, original)) {
    steps.add("Simplify", simplified, "Combine like terms and constants.");
  }
  let value: MathNumber | null = null;
  try {
    value = evaluateExact(simplified, context);
  } catch {
    value = null;
  }
  if (value !== null) {
    const result = num(value);
    if (!expressionEquals(result, simplified)) {
      steps.add("Result", result, "Evaluate what is left.");
    }
    return { kind: { kind: "value", value: result }, variable: null, steps: steps.steps, restatement: original };
  }
  // Free variables remain — the best answer is the simplified form.
  return {
    kind: { kind: "simplified", value: simplified },
    variable: null,
    steps: steps.steps,
    restatement: original,
  };
}

function checkClaim(
  relation: MathRelation,
  lhs: MathExpression,
  rhs: MathExpression,
  original: MathExpression,
  context: EvaluatorContext,
): MathSolution {
  const steps = new SolutionStepRecorder();
  steps.add("Start", original, "Check whether this is true.");
  let left: MathNumber;
  let right: MathNumber;
  try {
    left = evaluateExact(lhs, context);
    right = evaluateExact(rhs, context);
  } catch {
    return {
      kind: { kind: "simplified", value: original },
      variable: null,
      steps: steps.steps,
      restatement: original,
    };
  }
  steps.add(
    "Evaluate both sides",
    relationExpr(relation, num(left), num(right)),
    `${describeNumber(left)} ${spokenRelation(relation)} ${describeNumber(right)}?`,
  );
  let holds: boolean;
  switch (relation) {
    case "=":
      holds = doubleValue(left) === doubleValue(right);
      break;
    case "<":
      holds = doubleValue(left) < doubleValue(right);
      break;
    case "<=":
      holds = doubleValue(left) <= doubleValue(right);
      break;
    case ">":
      holds = doubleValue(left) > doubleValue(right);
      break;
    case ">=":
      holds = doubleValue(left) >= doubleValue(right);
      break;
  }
  return {
    kind: holds ? { kind: "identity" } : { kind: "contradiction" },
    variable: null,
    steps: steps.steps,
    restatement: original,
  };
}

// ---------------------------------------------------------------------------
// Linear

function solveLinear(
  polynomial: Polynomial,
  variable: string,
  original: MathExpression,
  steps: SolutionStepRecorder,
): MathSolution {
  const a = polynomial.at(1);
  const b = polynomial.at(0);
  steps.add(
    `Isolate the ${variable} term`,
    relationExpr("=", multiplyExpr([num(a), variableExpr(variable)]), num(negated(b))),
    `Move the constant across: ${renderNumber(a)}${variable} = ${renderNumber(negated(b))}.`,
  );
  const root = divideNumber(negated(b), a);
  const rootExpression = num(root);
  steps.add(
    `Divide by ${renderNumber(a)}`,
    relationExpr("=", variableExpr(variable), rootExpression),
    `${variable} = ${renderNumber(negated(b))} ÷ ${renderNumber(a)} = ${renderNumber(root)}.`,
  );
  return {
    kind: { kind: "roots", roots: [rootExpression] },
    variable,
    steps: steps.steps,
    restatement: original,
  };
}

// ---------------------------------------------------------------------------
// Quadratic

function solveQuadratic(
  polynomial: Polynomial,
  variable: string,
  original: MathExpression,
  steps: SolutionStepRecorder,
): MathSolution {
  const a = polynomial.at(2);
  const b = polynomial.at(1);
  const c = polynomial.at(0);
  steps.add(
    "Read off the coefficients",
    polynomial.expression(),
    `a = ${renderNumber(a)}, b = ${renderNumber(b)}, c = ${renderNumber(c)}.`,
  );

  const discriminant = subtract(multiply(b, b), multiply(multiply(integer(4), a), c));
  steps.add(
    "Discriminant",
    num(discriminant),
    `b² − 4ac = ${renderNumber(b)}² − 4·${renderNumber(a)}·${renderNumber(c)} = ${renderNumber(discriminant)}.`,
  );

  if (isNegative(discriminant)) {
    steps.add(
      "No real roots",
      num(discriminant),
      "The discriminant is negative, so the parabola never crosses the axis.",
    );
    return { kind: { kind: "roots", roots: [] }, variable, steps: steps.steps, restatement: original };
  }

  // Prefer an exact square root — it reads far better in a step-by-step than
  // the formula does, and it is what a person would do.
  const squareRoot = raisedTo(discriminant, rational(1, 2));
  const exactRoot = isExact(squareRoot);

  if (isZero(discriminant)) {
    const root = divideNumber(negated(b), multiply(integer(2), a));
    steps.add(
      "One repeated root",
      relationExpr("=", variableExpr(variable), num(root)),
      `With a zero discriminant, ${variable} = −b / 2a = ${renderNumber(root)}.`,
    );
    return {
      kind: { kind: "roots", roots: [num(root)] },
      variable,
      steps: steps.steps,
      restatement: original,
    };
  }

  steps.add(
    "Quadratic formula",
    relationExpr(
      "=",
      variableExpr(variable),
      divideExpr(addExpr([negate(num(b)), fn("sqrt", [num(discriminant)])]), multiplyExpr([int(2), num(a)])),
    ),
    "x = (−b ± √(b² − 4ac)) / 2a.",
  );

  const denominator = multiply(integer(2), a);
  let rootExpressions: MathExpression[];
  if (exactRoot) {
    const first = divideNumber(add(negated(b), squareRoot), denominator);
    const second = divideNumber(subtract(negated(b), squareRoot), denominator);
    const ordered = [first, second].sort((x, y) => doubleValue(x) - doubleValue(y));
    rootExpressions = ordered.map((value) => num(value));
    steps.add(
      "Exact roots",
      addExpr(rootExpressions),
      `√${renderNumber(discriminant)} = ${renderNumber(squareRoot)}, so the roots are exact.`,
    );
  } else {
    // Keep the surd symbolic: (−b ± √D) / 2a is the exact answer, and
    // collapsing it to decimals throws away information the wearer may want
    // to see.
    const surd = fn("sqrt", [num(discriminant)]);
    const plus = simplify(divideExpr(addExpr([num(negated(b)), surd]), num(denominator)));
    const minus = simplify(divideExpr(subtractExpr(num(negated(b)), surd), num(denominator)));
    rootExpressions = [plus, minus];
    const approximate: number[] = [];
    for (const root of rootExpressions) {
      try {
        approximate.push(doubleValue(evaluateExact(root)));
      } catch {
        // Leave it out of the approximation line.
      }
    }
    steps.add(
      "Roots",
      addExpr(rootExpressions),
      approximate.length === 2
        ? `≈ ${formatApprox(approximate[0]!)} and ${formatApprox(approximate[1]!)}.`
        : "The discriminant is not a perfect square, so the roots keep their radical.",
    );
  }

  return {
    kind: { kind: "roots", roots: rootExpressions },
    variable,
    steps: steps.steps,
    restatement: original,
  };
}

// ---------------------------------------------------------------------------
// Higher degree

function solvePolynomial(
  polynomial: Polynomial,
  variable: string,
  original: MathExpression,
  steps: SolutionStepRecorder,
): MathSolution {
  steps.add(
    `Degree ${polynomial.degree} polynomial`,
    polynomial.expression(),
    "Look for rational roots, then solve what is left.",
  );

  let remaining = polynomial;
  const found: MathNumber[] = [];

  // Rational root theorem: p/q where p divides the constant term and q
  // divides the leading coefficient. Cheap, exact, and it usually cracks the
  // textbook cases outright.
  for (;;) {
    if (remaining.degree <= 2) break;
    const root = rationalRoot(remaining);
    if (!root) break;
    found.push(root);
    remaining = remaining.dividingByRoot(root);
    steps.add(
      `Factor out (${variable} − ${renderNumber(root)})`,
      remaining.expression(),
      `${variable} = ${renderNumber(root)} is a root; divide it out.`,
    );
  }

  switch (remaining.degree) {
    case 1:
      found.push(divideNumber(negated(remaining.at(0)), remaining.at(1)));
      break;
    case 2: {
      const a = remaining.at(2);
      const b = remaining.at(1);
      const c = remaining.at(0);
      const discriminant = subtract(multiply(b, b), multiply(multiply(integer(4), a), c));
      if (!isNegative(discriminant)) {
        const squareRoot = raisedTo(discriminant, rational(1, 2));
        found.push(divideNumber(add(negated(b), squareRoot), multiply(integer(2), a)));
        if (!isZero(discriminant)) {
          found.push(divideNumber(subtract(negated(b), squareRoot), multiply(integer(2), a)));
        }
      }
      steps.add(
        "Solve the quadratic factor",
        remaining.expression(),
        "What is left is a quadratic; apply the formula.",
      );
      break;
    }
    default: {
      // No closed form available — find the real roots numerically.
      const numeric = numericRoots(remaining);
      found.push(...numeric.map((root) => fromDecimal(root)));
      steps.add(
        "Numeric roots",
        remaining.expression(),
        numeric.length === 0
          ? "No further real roots were found."
          : "No exact factorisation remains, so the rest are found numerically.",
      );
      break;
    }
  }

  const sorted = [...found].sort((x, y) => doubleValue(x) - doubleValue(y));
  return {
    kind: { kind: "roots", roots: sorted.map((value) => num(value)) },
    variable,
    steps: steps.steps,
    restatement: original,
  };
}

export function rationalRoot(polynomial: Polynomial): MathNumber | null {
  const integers = polynomial.integerCoefficients;
  if (!integers) return null;
  const constant = integers[0];
  const leading = integers[integers.length - 1];
  if (!constant || !leading) return null;

  const constantDivisors = divisorsOf(Math.abs(constant));
  const leadingDivisors = divisorsOf(Math.abs(leading));
  for (const p of constantDivisors) {
    for (const q of leadingDivisors) {
      for (const sign of [1, -1]) {
        const candidate = rational(sign * p, q);
        if (Math.abs(polynomial.value(doubleValue(candidate))) < 1e-9) {
          return candidate;
        }
      }
    }
  }
  return null;
}

function divisorsOf(value: number): number[] {
  if (value <= 0 || value >= 1_000_000) return [1];
  const result: number[] = [];
  for (let candidate = 1; candidate * candidate <= value; candidate++) {
    if (value % candidate === 0) {
      result.push(candidate);
      if (candidate !== value / candidate) result.push(value / candidate);
    }
  }
  return result.sort((a, b) => a - b);
}

/**
 * Bracket-and-bisect over a sampled range. Bisection rather than bare Newton
 * because Newton alone diverges on a bad seed, and a diverging solver on the
 * lens produces nonsense rather than nothing.
 */
export function numericRoots(
  polynomial: Polynomial,
  searchRange: [number, number] = [-1000, 1000],
  samples = 20_000,
): number[] {
  if (polynomial.degree < 1) return [];
  const [lower, upper] = searchRange;
  const roots: number[] = [];
  const step = (upper - lower) / samples;
  let previousX = lower;
  let previousY = polynomial.value(previousX);

  for (let index = 1; index <= samples; index++) {
    const x = lower + index * step;
    const y = polynomial.value(x);

    if (y === 0) {
      roots.push(x);
      previousX = x;
      previousY = y;
      continue;
    }
    if (Math.sign(previousY) === Math.sign(y) || previousY === 0) {
      previousX = x;
      previousY = y;
      continue;
    }

    let low = previousX;
    let high = x;
    for (let iteration = 0; iteration < 80; iteration++) {
      const mid = (low + high) / 2;
      const value = polynomial.value(mid);
      if (value === 0) {
        low = mid;
        high = mid;
        break;
      }
      if (Math.sign(value) === Math.sign(polynomial.value(low))) {
        low = mid;
      } else {
        high = mid;
      }
    }
    roots.push((low + high) / 2);
    previousX = x;
    previousY = y;
  }

  // Collapse near-duplicates from adjacent brackets around a tangency.
  const unique: number[] = [];
  for (const root of roots.sort((a, b) => a - b)) {
    if (!unique.some((existing) => Math.abs(existing - root) < 1e-7)) {
      unique.push(root);
    }
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Inequalities

function solveInequality(
  polynomial: Polynomial,
  relation: MathRelation,
  variable: string,
  original: MathExpression,
  steps: SolutionStepRecorder,
): MathSolution {
  if (polynomial.degree !== 1) {
    // Higher-degree inequalities need sign analysis across intervals; report
    // the roots rather than pretending to a full solution.
    const solution = solvePolynomial(polynomial, variable, original, steps);
    steps.add(
      "Critical points",
      polynomial.expression(),
      "The sign can only change at these values; test a point in each interval.",
    );
    return { kind: solution.kind, variable, steps: steps.steps, restatement: original };
  }

  const a = polynomial.at(1);
  const b = polynomial.at(0);
  const bound = divideNumber(negated(b), a);
  // Dividing by a negative flips the inequality — the single most common
  // mistake in this whole topic, so it gets its own visible step.
  const finalRelation = isNegative(a) ? flippedRelation(relation) : relation;
  steps.add(
    `Divide by ${renderNumber(a)}`,
    relationExpr(finalRelation, variableExpr(variable), num(bound)),
    isNegative(a)
      ? `Dividing by a negative flips the inequality to ${finalRelation}.`
      : `${variable} ${finalRelation} ${renderNumber(bound)}.`,
  );

  const isUpperBound = finalRelation === "<" || finalRelation === "<=";
  return {
    kind: {
      kind: "interval",
      lower: isUpperBound ? null : num(bound),
      upper: isUpperBound ? num(bound) : null,
      relation: finalRelation,
    },
    variable,
    steps: steps.steps,
    restatement: original,
  };
}

// ---------------------------------------------------------------------------
// Non-polynomial

function solveNumerically(
  difference: MathExpression,
  relation: MathRelation,
  variable: string,
  original: MathExpression,
  context: EvaluatorContext,
  steps: SolutionStepRecorder,
): MathSolution {
  steps.add(
    "Not a polynomial",
    difference,
    `${variable} appears inside a function, so the roots are found numerically.`,
  );
  let roots: number[] = [];
  const lower = -100;
  const upper = 100;
  const samples = 40_000;
  const step = (upper - lower) / samples;

  const evaluate = (x: number): number | null =>
    evaluateValue(difference, { [variable]: x }, context.usesDegrees);

  let previousX = lower;
  let previousY = evaluate(previousX);
  for (let index = 1; index <= samples; index++) {
    const x = lower + index * step;
    const y = evaluate(x);
    const lastX = previousX;
    const lastY = previousY;
    previousX = x;
    previousY = y;
    if (y === null || lastY === null) continue;
    // A sign change across a pole is not a root. Reject brackets where the
    // function magnitude explodes — that is `tan`'s asymptote, not a
    // crossing.
    if (Math.sign(lastY) === Math.sign(y)) continue;
    if (Math.abs(lastY) >= 1e6 || Math.abs(y) >= 1e6) continue;

    let low = lastX;
    let high = x;
    for (let iteration = 0; iteration < 60; iteration++) {
      const mid = (low + high) / 2;
      const value = evaluate(mid);
      if (value === null) break;
      if (value === 0) {
        low = mid;
        high = mid;
        break;
      }
      const lowValue = evaluate(low);
      if (lowValue !== null && Math.sign(value) === Math.sign(lowValue)) {
        low = mid;
      } else {
        high = mid;
      }
    }
    const root = (low + high) / 2;
    // Verify the root rather than trusting the sign change.
    //
    // A sign change also happens across a pole — tan(x) flips from +∞ to −∞
    // at π/2 — and bisection happily converges onto the asymptote. The
    // magnitude guard above does not catch it, because a sample 0.0025 away
    // from the pole is only ~400, nowhere near the cutoff. At a real root the
    // residual is ~1e-15; at a pole it is enormous.
    const residual = evaluate(root);
    if (residual === null || Math.abs(residual) >= 1e-6) continue;
    if (!roots.some((existing) => Math.abs(existing - root) < 1e-6)) roots.push(root);
  }

  // Keep the roots NEAREST ZERO, not the first twelve found.
  //
  // sin(x) = 0 has 64 roots in this window; scanning left to right and
  // stopping at twelve returned everything between −97 and −63 and nothing
  // near the origin, which is the opposite of what anyone asking
  // "solve sin x = 0" wants to see.
  const maximumRoots = 12;
  if (roots.length > maximumRoots) {
    roots = roots.sort((a, b) => Math.abs(a) - Math.abs(b)).slice(0, maximumRoots);
  }
  roots.sort((a, b) => a - b);

  steps.add(
    "Roots found",
    difference,
    roots.length === 0
      ? "No sign change was found between −100 and 100."
      : "Searched between −100 and 100 for sign changes.",
  );
  return {
    kind: { kind: "roots", roots: roots.map((root) => num(fromDecimal(root))) },
    variable,
    steps: steps.steps,
    restatement: original,
  };
}

function formatApprox(value: number): string {
  return describeNumber(real(value));
}
