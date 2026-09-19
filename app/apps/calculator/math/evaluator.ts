// Numeric evaluation of an expression tree. Two return paths on purpose:
// `evaluateExact` keeps rationals as rationals (so a solution can be shown as
// `3/2`), while `evaluateValue` collapses to a plain number for the plotter,
// which samples thousands of points and has no use for exactness.

import {
  type MathExpression,
  constantValue,
  evaluateFunction,
  functionIsDefined,
} from "./expression";
import {
  type MathNumber,
  add,
  doubleValue,
  integer,
  integerValue,
  isNegative,
  isZero,
  multiply,
  negated,
  raisedTo,
  real,
} from "./math-number";

export type EvaluatorContext = {
  variables: Record<string, MathNumber>;
  /**
   * Radians unless the caller says otherwise. Trig in degrees is a real user
   * expectation for a calculator, and getting it silently wrong produces
   * answers that look plausible.
   */
  usesDegrees: boolean;
};

export function radiansContext(): EvaluatorContext {
  return { variables: {}, usesDegrees: false };
}

export class EvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationError";
  }
}

/**
 * Evaluate keeping exactness where possible. Throws on a free variable, so
 * the caller can distinguish "not a number yet" from "evaluates to NaN".
 */
export function evaluateExact(expression: MathExpression, context: EvaluatorContext = radiansContext()): MathNumber {
  switch (expression.type) {
    case "number":
      return expression.value;

    case "variable": {
      const value = context.variables[expression.name];
      if (value === undefined) {
        throw new EvaluationError(`No value given for ${expression.name}`);
      }
      return value;
    }

    case "constant":
      return real(constantValue(expression.constant));

    case "add":
      return expression.terms.reduce<MathNumber>(
        (total, term) => add(total, evaluateExact(term, context)),
        integer(0),
      );

    case "multiply":
      return expression.factors.reduce<MathNumber>(
        (total, factor) => multiply(total, evaluateExact(factor, context)),
        integer(1),
      );

    case "negate":
      return negated(evaluateExact(expression.inner, context));

    case "power": {
      const baseValue = evaluateExact(expression.base, context);
      const exponentValue = evaluateExact(expression.exponent, context);
      if (isZero(baseValue) && isNegative(exponentValue)) {
        throw new EvaluationError("Division by zero");
      }
      return raisedTo(baseValue, exponentValue);
    }

    case "function": {
      const first = expression.args[0];
      if (!first) throw new EvaluationError(`${expression.fn} needs an argument`);
      const argument = evaluateExact(first, context);
      // Integer factorial stays exact; everything else goes through the
      // floating-point implementation.
      const argumentInt = integerValue(argument);
      if (expression.fn === "factorial" && argumentInt !== null && argumentInt >= 0 && argumentInt <= 20) {
        let total = 1;
        for (let value = 2; value <= argumentInt; value++) total *= value;
        return integer(total);
      }
      const raw = adjustForDegrees(expression.fn, doubleValue(argument), context);
      if (!functionIsDefined(expression.fn, raw)) {
        throw new EvaluationError(`${expression.fn} is undefined there`);
      }
      const result = evaluateFunction(expression.fn, raw);
      if (!Number.isFinite(result)) {
        throw new EvaluationError(`${expression.fn} is undefined there`);
      }
      return adjustResultForDegrees(expression.fn, result, context);
    }

    case "relation": {
      const left = doubleValue(evaluateExact(expression.lhs, context));
      const right = doubleValue(evaluateExact(expression.rhs, context));
      let holds: boolean;
      switch (expression.relation) {
        case "=":
          holds = left === right;
          break;
        case "<":
          holds = left < right;
          break;
        case "<=":
          holds = left <= right;
          break;
        case ">":
          holds = left > right;
          break;
        case ">=":
          holds = left >= right;
          break;
      }
      return integer(holds ? 1 : 0);
    }
  }
}

/**
 * Plotting path: never throws, returns null where the function is undefined
 * so the renderer can break the curve instead of drawing a line across the
 * gap.
 */
export function evaluateValue(
  expression: MathExpression,
  variables: Record<string, number>,
  usesDegrees = false,
): number | null {
  const context: EvaluatorContext = { variables: {}, usesDegrees };
  for (const name of Object.keys(variables)) {
    context.variables[name] = real(variables[name]!);
  }
  let result: MathNumber;
  try {
    result = evaluateExact(expression, context);
  } catch {
    return null;
  }
  const value = doubleValue(result);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Degrees

function adjustForDegrees(name: string, argument: number, context: EvaluatorContext): number {
  if (!context.usesDegrees) return argument;
  switch (name) {
    case "sin":
    case "cos":
    case "tan":
      return (argument * Math.PI) / 180;
    default:
      return argument;
  }
}

function adjustResultForDegrees(name: string, result: number, context: EvaluatorContext): MathNumber {
  if (!context.usesDegrees) return real(result);
  switch (name) {
    case "asin":
    case "acos":
    case "atan":
      return real((result * 180) / Math.PI);
    default:
      return real(result);
  }
}
