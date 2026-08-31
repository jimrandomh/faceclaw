// Symbolic differentiation. Every rule is applied structurally and the result
// is handed to the simplifier, so `d/dx (x^2)` comes back as `2x` rather than
// `2 · x^(2-1) · 1`. That matters because the derivative is user-visible — it
// is what "explain it" shows.

import {
  type MathExpression,
  type MathFunction,
  ONE,
  ZERO,
  addExpr,
  divideExpr,
  fn,
  int,
  multiplyExpr,
  negate,
  powerExpr,
  relation,
  subtractExpr,
  variablesOf,
} from "./expression";
import { simplify } from "./simplifier";
import { evaluateValue } from "./evaluator";

export function differentiate(expression: MathExpression, withRespectTo: string): MathExpression {
  return simplify(raw(expression, withRespectTo));
}

/** Nth derivative. */
export function differentiateOrder(
  expression: MathExpression,
  withRespectTo: string,
  order: number,
): MathExpression {
  let current = expression;
  for (let step = 0; step < Math.max(0, order); step++) {
    current = differentiate(current, withRespectTo);
  }
  return current;
}

function raw(expression: MathExpression, variable: string): MathExpression {
  switch (expression.type) {
    case "number":
    case "constant":
      return ZERO;

    case "variable":
      return expression.name === variable ? ONE : ZERO;

    case "negate":
      return negate(raw(expression.inner, variable));

    case "add":
      return addExpr(expression.terms.map((term) => raw(term, variable)));

    case "multiply": {
      // Product rule, generalised: d(abc) = a'bc + ab'c + abc'.
      const terms: MathExpression[] = [];
      for (let index = 0; index < expression.factors.length; index++) {
        const replaced = [...expression.factors];
        replaced[index] = raw(expression.factors[index]!, variable);
        terms.push(multiplyExpr(replaced));
      }
      return addExpr(terms);
    }

    case "power":
      return differentiatePower(expression.base, expression.exponent, variable);

    case "function": {
      const argument = expression.args[0];
      if (!argument) return ZERO;
      const outer = derivativeOfFunction(expression.fn, argument);
      // Chain rule. Skipping this when the argument is the bare variable
      // would be a needless special case — the simplifier removes the `· 1`
      // anyway.
      return multiplyExpr([outer, raw(argument, variable)]);
    }

    case "relation":
      // Differentiating both sides of an equation is implicit
      // differentiation's first step; useful, and harmless here.
      return relation(expression.relation, raw(expression.lhs, variable), raw(expression.rhs, variable));
  }
}

function differentiatePower(
  base: MathExpression,
  exponent: MathExpression,
  variable: string,
): MathExpression {
  const baseHasVariable = variablesOf(base).includes(variable);
  const exponentHasVariable = variablesOf(exponent).includes(variable);

  if (!baseHasVariable && !exponentHasVariable) return ZERO;

  if (baseHasVariable && !exponentHasVariable) {
    // Power rule: d(u^n) = n · u^(n-1) · u'
    const reduced = subtractExpr(exponent, ONE);
    return multiplyExpr([exponent, powerExpr(base, reduced), raw(base, variable)]);
  }

  if (!baseHasVariable && exponentHasVariable) {
    // Exponential rule: d(a^v) = a^v · ln(a) · v'
    return multiplyExpr([powerExpr(base, exponent), fn("ln", [base]), raw(exponent, variable)]);
  }

  // General case via logarithmic differentiation:
  //   d(u^v) = u^v · (v' · ln u + v · u'/u)
  const uv = powerExpr(base, exponent);
  const firstTerm = multiplyExpr([raw(exponent, variable), fn("ln", [base])]);
  const secondTerm = multiplyExpr([exponent, divideExpr(raw(base, variable), base)]);
  return multiplyExpr([uv, addExpr([firstTerm, secondTerm])]);
}

/** The outer derivative only; the caller applies the chain rule. */
function derivativeOfFunction(name: MathFunction, argument: MathExpression): MathExpression {
  switch (name) {
    case "sin":
      return fn("cos", [argument]);
    case "cos":
      return negate(fn("sin", [argument]));
    case "tan":
      // sec² = 1 / cos²
      return divideExpr(ONE, powerExpr(fn("cos", [argument]), int(2)));
    case "asin":
      return divideExpr(ONE, fn("sqrt", [subtractExpr(ONE, powerExpr(argument, int(2)))]));
    case "acos":
      return negate(divideExpr(ONE, fn("sqrt", [subtractExpr(ONE, powerExpr(argument, int(2)))])));
    case "atan":
      return divideExpr(ONE, addExpr([ONE, powerExpr(argument, int(2))]));
    case "sinh":
      return fn("cosh", [argument]);
    case "cosh":
      return fn("sinh", [argument]);
    case "tanh":
      return divideExpr(ONE, powerExpr(fn("cosh", [argument]), int(2)));
    case "ln":
      return divideExpr(ONE, argument);
    case "log10":
      return divideExpr(ONE, multiplyExpr([argument, fn("ln", [int(10)])]));
    case "log2":
      return divideExpr(ONE, multiplyExpr([argument, fn("ln", [int(2)])]));
    case "sqrt":
      return divideExpr(ONE, multiplyExpr([int(2), fn("sqrt", [argument])]));
    case "cbrt":
      return divideExpr(ONE, multiplyExpr([int(3), powerExpr(fn("cbrt", [argument]), int(2))]));
    case "exp":
      return fn("exp", [argument]);
    case "abs":
      // d|u|/du = u/|u| — undefined at zero, which the plotter's
      // discontinuity handling already copes with.
      return divideExpr(argument, fn("abs", [argument]));
    case "floor":
    case "ceil":
    case "round":
      // Zero almost everywhere; the jumps are measure-zero and are not
      // representable here.
      return ZERO;
    case "factorial":
      // The derivative of the gamma function needs the digamma function,
      // which this build does not carry. Returning zero would be a lie, so
      // the caller gets an unevaluated marker instead.
      return fn("factorial", [argument]);
  }
}

// ---------------------------------------------------------------------------
// Numeric integration

/**
 * Definite integral by adaptive Simpson's rule.
 *
 * Numeric rather than symbolic: symbolic integration needs a Risch-style
 * algorithm that is far out of proportion to the feature, and a definite
 * value is what a calculator user actually asks for. (The symbolic table in
 * symbolic-integral.ts is tried first where it applies.)
 */
export function integrateNumeric(
  expression: MathExpression,
  variable: string,
  lower: number,
  upper: number,
  tolerance = 1e-9,
): number | null {
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
  if (lower === upper) return 0;
  if (lower > upper) {
    const flipped = integrateNumeric(expression, variable, upper, lower, tolerance);
    return flipped === null ? null : -flipped;
  }

  const f = (x: number): number | null => evaluateValue(expression, { [variable]: x });

  const simpson = (a: number, b: number, fa: number, fb: number, fm: number): number =>
    ((b - a) / 6) * (fa + 4 * fm + fb);

  const adaptive = (
    a: number,
    b: number,
    fa: number,
    fb: number,
    fm: number,
    whole: number,
    depth: number,
  ): number | null => {
    const m = (a + b) / 2;
    const leftMid = (a + m) / 2;
    const rightMid = (m + b) / 2;
    const flm = f(leftMid);
    const frm = f(rightMid);
    if (flm === null || frm === null) return null;
    const left = simpson(a, m, fa, fm, flm);
    const right = simpson(m, b, fm, fb, frm);
    const total = left + right;
    // Richardson: the Simpson error term is (total - whole) / 15.
    if (depth <= 0 || Math.abs(total - whole) <= 15 * tolerance) {
      return total + (total - whole) / 15;
    }
    const leftResult = adaptive(a, m, fa, fm, flm, left, depth - 1);
    if (leftResult === null) return null;
    const rightResult = adaptive(m, b, fm, fb, frm, right, depth - 1);
    if (rightResult === null) return null;
    return leftResult + rightResult;
  };

  const fa = f(lower);
  const fb = f(upper);
  const fm = f((lower + upper) / 2);
  if (fa === null || fb === null || fm === null) return null;
  const whole = simpson(lower, upper, fa, fb, fm);
  return adaptive(lower, upper, fa, fb, fm, whole, 24);
}
