// Symbolic antiderivatives. Not a Risch implementation — that is a
// research-grade algorithm and wildly out of proportion here. This is the
// standard table plus three structural rules (linearity, linear substitution,
// integration by parts), which is what actually covers a calculus course.
// Anything outside that returns null rather than a wrong answer, and the
// caller falls back to the numeric integrator, which always works.

import {
  type MathExpression,
  addExpr,
  divideExpr,
  fn,
  int,
  multiplyExpr,
  negate,
  num,
  numberValue,
  powerExpr,
  subtractExpr,
  variable as variableExpr,
  variablesOf,
} from "./expression";
import {
  type MathNumber,
  add,
  fromDecimal,
  integer,
  multiply,
  numberEquals,
  rational,
  reciprocal,
} from "./math-number";
import { simplify } from "./simplifier";
import { differentiate, integrateNumeric } from "./derivative";
import { evaluateValue } from "./evaluator";
import { Polynomial } from "./polynomial";
import { isZero } from "./math-number";

/** Indefinite integral with respect to `variable`, without the constant. */
export function integrate(expression: MathExpression, variable: string): MathExpression | null {
  const raw = attempt(simplify(expression), variable, 0);
  if (!raw) return null;
  return simplify(raw);
}

/** With `+ C`, for display. */
export function integrateWithConstant(expression: MathExpression, variable: string): MathExpression | null {
  const result = integrate(expression, variable);
  return result ? addExpr([result, variableExpr("C")]) : null;
}

function attempt(expression: MathExpression, variable: string, depth: number): MathExpression | null {
  // Integration by parts can recurse; bound it so a bad pairing cannot loop
  // forever.
  if (depth >= 6) return null;

  // Constant with respect to the variable: ∫c dx = cx
  if (!variablesOf(expression).includes(variable)) {
    return multiplyExpr([expression, variableExpr(variable)]);
  }

  switch (expression.type) {
    case "variable":
      if (expression.name === variable) {
        return divideExpr(powerExpr(variableExpr(variable), int(2)), int(2));
      }
      // A variable other than the integration variable is already handled by
      // the constant guard above; nothing reaches here.
      return null;

    case "negate": {
      const inner = attempt(expression.inner, variable, depth);
      return inner ? negate(inner) : null;
    }

    case "add": {
      // Linearity. If any term is not integrable the whole thing is not.
      const integrated: MathExpression[] = [];
      for (const term of expression.terms) {
        const part = attempt(term, variable, depth);
        if (!part) return null;
        integrated.push(part);
      }
      return addExpr(integrated);
    }

    case "multiply":
      return integrateProduct(expression.factors, variable, depth);

    case "power":
      return integratePower(expression.base, expression.exponent, variable);

    case "function": {
      const argument = expression.args[0];
      if (!argument) return null;
      return integrateFunction(expression.fn, argument, variable);
    }

    case "number":
    case "constant":
    case "relation":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Products

function integrateProduct(
  factors: MathExpression[],
  variable: string,
  depth: number,
): MathExpression | null {
  // Pull constants out front: ∫ c·f dx = c·∫f dx
  const constants: MathExpression[] = [];
  const variableFactors: MathExpression[] = [];
  for (const factor of factors) {
    if (variablesOf(factor).includes(variable)) {
      variableFactors.push(factor);
    } else {
      constants.push(factor);
    }
  }
  if (variableFactors.length === 0) {
    return multiplyExpr([...factors, variableExpr(variable)]);
  }
  if (constants.length > 0) {
    const inner = variableFactors.length === 1 ? variableFactors[0]! : multiplyExpr(variableFactors);
    const integrated = attempt(inner, variable, depth);
    if (!integrated) return null;
    return multiplyExpr([...constants, integrated]);
  }
  if (variableFactors.length !== 2) return null;
  return integrateByParts(variableFactors[0]!, variableFactors[1]!, variable, depth);
}

/**
 * ∫u dv = uv − ∫v du.
 *
 * Picks `u` by the LIATE heuristic: whichever factor differentiates toward
 * nothing goes in `u`. Getting this backwards turns a one-step integral into
 * an infinite regress, which is why the depth bound above exists.
 */
function integrateByParts(
  first: MathExpression,
  second: MathExpression,
  variable: string,
  depth: number,
): MathExpression | null {
  const priority = (expression: MathExpression): number => {
    if (expression.type === "function") {
      switch (expression.fn) {
        case "ln":
        case "log10":
        case "log2":
          return 5;
        case "asin":
        case "acos":
        case "atan":
          return 4;
        case "sin":
        case "cos":
        case "tan":
          return 2;
        case "exp":
          return 1;
        default:
          return 0;
      }
    }
    if (expression.type === "variable" || expression.type === "power") return 3;
    return 0;
  };

  const [u, dv] = priority(first) >= priority(second) ? [first, second] : [second, first];

  const v = attempt(dv, variable, depth + 1);
  if (!v) return null;
  const du = differentiate(u, variable);
  const remainder = simplify(multiplyExpr([v, du]));
  const integratedRemainder = attempt(remainder, variable, depth + 1);
  if (!integratedRemainder) return null;
  return subtractExpr(multiplyExpr([u, v]), integratedRemainder);
}

// ---------------------------------------------------------------------------
// Powers

function integratePower(
  base: MathExpression,
  exponent: MathExpression,
  variable: string,
): MathExpression | null {
  const baseHasVariable = variablesOf(base).includes(variable);
  const exponentHasVariable = variablesOf(exponent).includes(variable);

  // Exponential: ∫a^x dx = a^x / ln a
  if (!baseHasVariable && exponentHasVariable) {
    const linear = linearForm(exponent, variable);
    if (!linear) return null;
    const antiderivative = divideExpr(powerExpr(base, exponent), fn("ln", [base]));
    return divideExpr(antiderivative, num(linear.slope));
  }

  if (!baseHasVariable || exponentHasVariable) return null;
  const power = numberValue(exponent);
  if (!power) return null;

  // Chain rule in reverse, but only for a LINEAR inner function. For a
  // nonlinear inner function the substitution needs its own du, which this
  // level of machinery cannot supply — returning null there is the
  // difference between "no symbolic form" and a wrong one.
  const linear = linearForm(base, variable);
  if (!linear) return null;

  // ∫(ax+b)^-1 dx = ln|ax+b| / a
  if (numberEquals(power, integer(-1))) {
    return divideExpr(fn("ln", [fn("abs", [base])]), num(linear.slope));
  }
  const raised = add(power, integer(1));
  return divideExpr(powerExpr(base, num(raised)), num(multiply(raised, linear.slope)));
}

// ---------------------------------------------------------------------------
// Functions

function integrateFunction(
  functionName: string,
  argument: MathExpression,
  variable: string,
): MathExpression | null {
  // Same restriction as powers: the inner function must be linear, or the
  // substitution is not this simple.
  const linear = linearForm(argument, variable);
  if (!linear) return null;
  const scale = num(reciprocal(linear.slope));

  let antiderivative: MathExpression | null;
  switch (functionName) {
    case "sin":
      antiderivative = negate(fn("cos", [argument]));
      break;
    case "cos":
      antiderivative = fn("sin", [argument]);
      break;
    case "tan":
      antiderivative = negate(fn("ln", [fn("abs", [fn("cos", [argument])])]));
      break;
    case "exp":
      antiderivative = fn("exp", [argument]);
      break;
    case "sinh":
      antiderivative = fn("cosh", [argument]);
      break;
    case "cosh":
      antiderivative = fn("sinh", [argument]);
      break;
    case "ln":
      // ∫ln(u) du = u·ln(u) − u
      antiderivative = subtractExpr(multiplyExpr([argument, fn("ln", [argument])]), argument);
      break;
    case "sqrt":
      // ∫√u du = (2/3)·u^(3/2)
      antiderivative = multiplyExpr([num(rational(2, 3)), powerExpr(argument, num(rational(3, 2)))]);
      break;
    default:
      antiderivative = null;
      break;
  }
  if (!antiderivative) return null;
  return multiplyExpr([scale, antiderivative]);
}

// ---------------------------------------------------------------------------
// Definite

export type DefiniteResult =
  /** Evaluated from an exact antiderivative — the fundamental theorem. */
  | { kind: "exact"; value: MathNumber; antiderivative: MathExpression }
  /** No symbolic form; the value came from adaptive Simpson. */
  | { kind: "numeric"; value: number }
  | { kind: "failed"; reason: string };

/**
 * Prefer the symbolic route so the answer can show its working, and fall
 * back to numerics so the question always gets answered.
 */
export function definite(
  expression: MathExpression,
  variable: string,
  lower: number,
  upper: number,
): DefiniteResult {
  const antiderivative = integrate(expression, variable);
  if (antiderivative) {
    const atUpper = evaluateValue(antiderivative, { [variable]: upper });
    const atLower = evaluateValue(antiderivative, { [variable]: lower });
    if (atUpper !== null && atLower !== null && Number.isFinite(atUpper) && Number.isFinite(atLower)) {
      return { kind: "exact", value: fromDecimal(atUpper - atLower), antiderivative };
    }
  }
  const value = integrateNumeric(expression, variable, lower, upper);
  if (value === null) {
    return { kind: "failed", reason: "The function is undefined somewhere in that range" };
  }
  return { kind: "numeric", value };
}

// ---------------------------------------------------------------------------
// Linear form

/**
 * Recognises `a·x + b`, which is the only inner function the substitution
 * rules above can undo.
 */
export function linearForm(
  expression: MathExpression,
  variable: string,
): { slope: MathNumber; intercept: MathNumber } | null {
  const polynomial = Polynomial.extract(expression, variable);
  if (!polynomial || polynomial.degree !== 1 || isZero(polynomial.at(1))) return null;
  return { slope: polynomial.at(1), intercept: polynomial.at(0) };
}
