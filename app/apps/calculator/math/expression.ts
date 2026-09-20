// The expression tree everything else operates on: evaluation, simplification,
// differentiation, solving, rendering, and plotting. A plain discriminated
// union so the whole tree is a value — simplification and differentiation can
// rebuild subtrees freely, and structural comparison (expressionEquals) gives
// the simplifier the like-term matching it leans on heavily.

import {
  type MathNumber,
  integer as makeInteger,
  fromDecimal,
  isZero as numberIsZero,
  isOne as numberIsOne,
  numberEquals as numbersEqual,
} from "./math-number";

export type MathRelation = "=" | "<" | "<=" | ">" | ">=";

export type MathConstant = "pi" | "e" | "tau";

export type MathFunction =
  | "sin"
  | "cos"
  | "tan"
  | "asin"
  | "acos"
  | "atan"
  | "sinh"
  | "cosh"
  | "tanh"
  | "ln"
  | "log10"
  | "log2"
  | "sqrt"
  | "cbrt"
  | "abs"
  | "exp"
  | "floor"
  | "ceil"
  | "round"
  | "factorial";

export const ALL_FUNCTIONS: readonly MathFunction[] = [
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "ln",
  "log10",
  "log2",
  "sqrt",
  "cbrt",
  "abs",
  "exp",
  "floor",
  "ceil",
  "round",
  "factorial",
];

export const ALL_CONSTANTS: readonly MathConstant[] = ["pi", "e", "tau"];

export type MathExpression =
  | { type: "number"; value: MathNumber }
  /** A free variable — `x`, `y`, `theta`. */
  | { type: "variable"; name: string }
  /**
   * A named constant with a known value (`pi`, `e`). Kept distinct from
   * `variable` so "solve for pi" is impossible and `2π` stays exact instead of
   * becoming 6.283…
   */
  | { type: "constant"; constant: MathConstant }
  | { type: "add"; terms: MathExpression[] }
  | { type: "multiply"; factors: MathExpression[] }
  | { type: "power"; base: MathExpression; exponent: MathExpression }
  /**
   * Unary negation. Not folded into `multiply([-1, x])` because the renderers
   * and the step explanations both want to say "negative x".
   */
  | { type: "negate"; inner: MathExpression }
  | { type: "function"; fn: MathFunction; args: MathExpression[] }
  /** An equation or inequality — the root node of anything solvable. */
  | { type: "relation"; relation: MathRelation; lhs: MathExpression; rhs: MathExpression };

// ---------------------------------------------------------------------------
// Convenience constructors

export function num(value: MathNumber): MathExpression {
  return { type: "number", value };
}

export function int(value: number): MathExpression {
  return num(makeInteger(value));
}

export function realExpr(value: number): MathExpression {
  return num(fromDecimal(value));
}

export function variable(name: string): MathExpression {
  return { type: "variable", name };
}

export function constant(value: MathConstant): MathExpression {
  return { type: "constant", constant: value };
}

export function addExpr(terms: MathExpression[]): MathExpression {
  return { type: "add", terms };
}

export function multiplyExpr(factors: MathExpression[]): MathExpression {
  return { type: "multiply", factors };
}

export function powerExpr(base: MathExpression, exponent: MathExpression): MathExpression {
  return { type: "power", base, exponent };
}

export function negate(inner: MathExpression): MathExpression {
  return { type: "negate", inner };
}

export function fn(name: MathFunction, args: MathExpression[]): MathExpression {
  return { type: "function", fn: name, args };
}

export function relation(rel: MathRelation, lhs: MathExpression, rhs: MathExpression): MathExpression {
  return { type: "relation", relation: rel, lhs, rhs };
}

export function subtractExpr(lhs: MathExpression, rhs: MathExpression): MathExpression {
  return addExpr([lhs, negate(rhs)]);
}

/**
 * Division is `a * b^-1` in the tree, which is what makes the simplifier and
 * the differentiator tractable — the renderers detect the pattern and print a
 * real fraction, so nothing user-visible degrades.
 */
export function divideExpr(lhs: MathExpression, rhs: MathExpression): MathExpression {
  return multiplyExpr([lhs, powerExpr(rhs, int(-1))]);
}

export const ZERO: MathExpression = int(0);
export const ONE: MathExpression = int(1);

// ---------------------------------------------------------------------------
// Introspection

export function isZeroExpr(expression: MathExpression): boolean {
  return expression.type === "number" && numberIsZero(expression.value);
}

export function isOneExpr(expression: MathExpression): boolean {
  return expression.type === "number" && numberIsOne(expression.value);
}

export function numberValue(expression: MathExpression): MathNumber | null {
  return expression.type === "number" ? expression.value : null;
}

/**
 * Every free variable in the tree, in first-appearance order. Order matters:
 * it decides which variable "solve for x" defaults to and which axis a
 * single-variable graph uses.
 */
export function variablesOf(expression: MathExpression): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  collectVariables(expression, ordered, seen);
  return ordered;
}

function collectVariables(expression: MathExpression, ordered: string[], seen: Set<string>): void {
  switch (expression.type) {
    case "variable":
      if (!seen.has(expression.name)) {
        seen.add(expression.name);
        ordered.push(expression.name);
      }
      break;
    case "number":
    case "constant":
      break;
    case "add":
      for (const term of expression.terms) collectVariables(term, ordered, seen);
      break;
    case "multiply":
      for (const factor of expression.factors) collectVariables(factor, ordered, seen);
      break;
    case "power":
      collectVariables(expression.base, ordered, seen);
      collectVariables(expression.exponent, ordered, seen);
      break;
    case "negate":
      collectVariables(expression.inner, ordered, seen);
      break;
    case "function":
      for (const argument of expression.args) collectVariables(argument, ordered, seen);
      break;
    case "relation":
      collectVariables(expression.lhs, ordered, seen);
      collectVariables(expression.rhs, ordered, seen);
      break;
  }
}

export function isRelation(expression: MathExpression): boolean {
  return expression.type === "relation";
}

/**
 * Node count — used to pick the simpler of two equivalent forms and to bound
 * runaway expansion in the simplifier.
 */
export function complexity(expression: MathExpression): number {
  switch (expression.type) {
    case "number":
    case "variable":
    case "constant":
      return 1;
    case "add":
      return 1 + expression.terms.reduce((total, term) => total + complexity(term), 0);
    case "multiply":
      return 1 + expression.factors.reduce((total, factor) => total + complexity(factor), 0);
    case "power":
      return 1 + complexity(expression.base) + complexity(expression.exponent);
    case "negate":
      return 1 + complexity(expression.inner);
    case "function":
      return 1 + expression.args.reduce((total, argument) => total + complexity(argument), 0);
    case "relation":
      return 1 + complexity(expression.lhs) + complexity(expression.rhs);
  }
}

/** Replace every occurrence of a variable with an expression. */
export function substituting(
  expression: MathExpression,
  name: string,
  replacement: MathExpression,
): MathExpression {
  switch (expression.type) {
    case "variable":
      return expression.name === name ? replacement : expression;
    case "number":
    case "constant":
      return expression;
    case "add":
      return addExpr(expression.terms.map((term) => substituting(term, name, replacement)));
    case "multiply":
      return multiplyExpr(expression.factors.map((factor) => substituting(factor, name, replacement)));
    case "power":
      return powerExpr(
        substituting(expression.base, name, replacement),
        substituting(expression.exponent, name, replacement),
      );
    case "negate":
      return negate(substituting(expression.inner, name, replacement));
    case "function":
      return fn(
        expression.fn,
        expression.args.map((argument) => substituting(argument, name, replacement)),
      );
    case "relation":
      return relation(
        expression.relation,
        substituting(expression.lhs, name, replacement),
        substituting(expression.rhs, name, replacement),
      );
  }
}

/**
 * Structural equality with value-equal numbers (MathNumber compares by
 * value).
 */
export function expressionEquals(a: MathExpression, b: MathExpression): boolean {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "number": {
      const other = b as Extract<MathExpression, { type: "number" }>;
      return numbersEqual(a.value, other.value);
    }
    case "variable":
      return a.name === (b as Extract<MathExpression, { type: "variable" }>).name;
    case "constant":
      return a.constant === (b as Extract<MathExpression, { type: "constant" }>).constant;
    case "add": {
      const other = b as Extract<MathExpression, { type: "add" }>;
      return listEquals(a.terms, other.terms);
    }
    case "multiply": {
      const other = b as Extract<MathExpression, { type: "multiply" }>;
      return listEquals(a.factors, other.factors);
    }
    case "power": {
      const other = b as Extract<MathExpression, { type: "power" }>;
      return expressionEquals(a.base, other.base) && expressionEquals(a.exponent, other.exponent);
    }
    case "negate":
      return expressionEquals(a.inner, (b as Extract<MathExpression, { type: "negate" }>).inner);
    case "function": {
      const other = b as Extract<MathExpression, { type: "function" }>;
      return a.fn === other.fn && listEquals(a.args, other.args);
    }
    case "relation": {
      const other = b as Extract<MathExpression, { type: "relation" }>;
      return (
        a.relation === other.relation &&
        expressionEquals(a.lhs, other.lhs) &&
        expressionEquals(a.rhs, other.rhs)
      );
    }
  }
}

function listEquals(a: MathExpression[], b: MathExpression[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (!expressionEquals(a[index]!, b[index]!)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Relations

/**
 * The relation you get by multiplying or dividing both sides by a negative —
 * the classic inequality mistake, handled explicitly.
 */
export function flippedRelation(rel: MathRelation): MathRelation {
  switch (rel) {
    case "=":
      return "=";
    case "<":
      return ">";
    case "<=":
      return ">=";
    case ">":
      return "<";
    case ">=":
      return "<=";
  }
}

export function spokenRelation(rel: MathRelation): string {
  switch (rel) {
    case "=":
      return "equals";
    case "<":
      return "is less than";
    case "<=":
      return "is at most";
    case ">":
      return "is greater than";
    case ">=":
      return "is at least";
  }
}

// ---------------------------------------------------------------------------
// Constants

export function constantValue(value: MathConstant): number {
  switch (value) {
    case "pi":
      return Math.PI;
    case "e":
      return Math.E;
    case "tau":
      return 2 * Math.PI;
  }
}

// ---------------------------------------------------------------------------
// Functions

export function evaluateFunction(name: MathFunction, argument: number): number {
  switch (name) {
    case "sin":
      return Math.sin(argument);
    case "cos":
      return Math.cos(argument);
    case "tan":
      return Math.tan(argument);
    case "asin":
      return Math.asin(argument);
    case "acos":
      return Math.acos(argument);
    case "atan":
      return Math.atan(argument);
    case "sinh":
      return Math.sinh(argument);
    case "cosh":
      return Math.cosh(argument);
    case "tanh":
      return Math.tanh(argument);
    case "ln":
      return Math.log(argument);
    case "log10":
      return Math.log10(argument);
    case "log2":
      return Math.log2(argument);
    case "sqrt":
      return Math.sqrt(argument);
    case "cbrt":
      return Math.cbrt(argument);
    case "abs":
      return Math.abs(argument);
    case "exp":
      return Math.exp(argument);
    case "floor":
      return Math.floor(argument);
    case "ceil":
      return Math.ceil(argument);
    case "round":
      return Math.round(argument);
    case "factorial":
      // Real factorial via the gamma function, so `2.5!` is defined rather
      // than an error — and so the evaluator has one code path for both.
      return gamma(argument + 1);
  }
}

/**
 * Domain check used by the plotter to break a curve rather than draw a line
 * through a gap (`ln` left of zero, `tan` at its asymptotes).
 */
export function functionIsDefined(name: MathFunction, argument: number): boolean {
  switch (name) {
    case "ln":
    case "log10":
    case "log2":
      return argument > 0;
    case "sqrt":
      return argument >= 0;
    case "asin":
    case "acos":
      return argument >= -1 && argument <= 1;
    case "factorial":
      return argument > -1 || Math.round(argument) !== argument;
    default:
      return true;
  }
}

/**
 * Lanczos approximation of the gamma function (JavaScript has no tgamma).
 * Accurate to well past the display precision used anywhere in this app.
 */
export function gamma(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Math.round(x)) {
    if (x <= 0) return NaN; // poles at non-positive integers
    if (x <= 171) {
      let result = 1;
      for (let k = 2; k < x; k++) result *= k;
      return result;
    }
    return Infinity;
  }
  if (x < 0.5) {
    // Reflection formula.
    return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  }
  const g = 7;
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  const z = x - 1;
  let sum = coefficients[0]!;
  for (let index = 1; index < g + 2; index++) {
    sum += coefficients[index]! / (z + index);
  }
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * sum;
}
