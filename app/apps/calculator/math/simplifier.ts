// Canonicalises an expression tree. The goal is not a full CAS — it is a
// *stable canonical form*, because three downstream features depend on one:
//
// * the solver compares subtrees for equality to collect like terms,
// * the step explanations need `2x + 3x` to visibly become `5x`,
// * the renderers should not print `1 * x + 0`.
//
// Rewriting runs to a fixed point with an iteration cap, so a rule pair that
// oscillates degrades to "stopped early" rather than hanging the app.

import {
  type MathExpression,
  type MathFunction,
  ONE,
  ZERO,
  addExpr,
  expressionEquals,
  fn,
  functionIsDefined,
  evaluateFunction,
  isOneExpr,
  isZeroExpr,
  multiplyExpr,
  negate,
  num,
  numberValue,
  powerExpr,
  relation,
  variablesOf,
} from "./expression";
import {
  type MathNumber,
  add,
  doubleValue,
  fromDecimal,
  integer,
  integerValue,
  isExact,
  isOne,
  isZero,
  isNegative,
  multiply,
  negated,
  numberEquals,
  raisedTo,
  rational,
} from "./math-number";

const MAXIMUM_PASSES = 24;

export function simplify(expression: MathExpression): MathExpression {
  let current = expression;
  for (let iteration = 0; iteration < MAXIMUM_PASSES; iteration++) {
    const next = pass(current);
    if (expressionEquals(next, current)) return next;
    current = next;
  }
  return current;
}

// ---------------------------------------------------------------------------
// One rewrite pass

function pass(expression: MathExpression): MathExpression {
  switch (expression.type) {
    case "number":
    case "variable":
    case "constant":
      return expression;

    case "negate": {
      const simplified = pass(expression.inner);
      const value = numberValue(simplified);
      if (value) return num(negated(value));
      // Double negation.
      if (simplified.type === "negate") return simplified.inner;
      return negate(simplified);
    }

    case "add":
      return simplifySum(expression.terms.map(pass));

    case "multiply":
      return simplifyProduct(expression.factors.map(pass));

    case "power":
      return simplifyPower(pass(expression.base), pass(expression.exponent));

    case "function": {
      const simplified = expression.args.map(pass);
      // Fold a constant argument, but only when the result stays clean —
      // `sqrt(2)` must remain symbolic, not become 1.4142135623730951 in the
      // middle of an exact solution.
      const first = simplified[0];
      if (first) {
        const value = numberValue(first);
        if (value) {
          const folded = foldFunction(expression.fn, value);
          if (folded) return num(folded);
        }
      }
      return fn(expression.fn, simplified);
    }

    case "relation":
      return relation(expression.relation, pass(expression.lhs), pass(expression.rhs));
  }
}

// ---------------------------------------------------------------------------
// Sums

function simplifySum(rawTerms: MathExpression[]): MathExpression {
  const flattened: MathExpression[] = [];
  for (const term of rawTerms) {
    if (term.type === "add") {
      flattened.push(...term.terms);
    } else {
      flattened.push(term);
    }
  }

  // Collect like terms by their non-numeric part: 2x + 3x → 5x.
  let constantTotal: MathNumber = integer(0);
  const collected: { key: MathExpression; coefficient: MathNumber }[] = [];

  for (const term of flattened) {
    const value = numberValue(term);
    if (value) {
      constantTotal = add(constantTotal, value);
      continue;
    }
    const [coefficient, key] = splitCoefficient(term);
    const existing = collected.find((entry) => expressionEquals(entry.key, key));
    if (existing) {
      existing.coefficient = add(existing.coefficient, coefficient);
    } else {
      collected.push({ key, coefficient });
    }
  }

  const terms: MathExpression[] = [];
  for (const entry of collected) {
    if (isZero(entry.coefficient)) continue;
    terms.push(rebuild(entry.coefficient, entry.key));
  }
  // Stable ordering: highest polynomial degree first, which is how a person
  // writes it and how the quadratic solver expects to read it.
  terms.sort((a, b) => degree(b) - degree(a));

  if (!isZero(constantTotal)) terms.push(num(constantTotal));
  if (terms.length === 0) return ZERO;
  return terms.length === 1 ? terms[0]! : addExpr(terms);
}

/**
 * Split a term into its numeric coefficient and the rest, so like terms can
 * be matched: `3 * x * y` → (3, x*y), `-x` → (-1, x).
 */
export function splitCoefficient(term: MathExpression): [MathNumber, MathExpression] {
  switch (term.type) {
    case "negate": {
      const [coefficient, key] = splitCoefficient(term.inner);
      return [negated(coefficient), key];
    }
    case "multiply": {
      let coefficient: MathNumber = integer(1);
      const rest: MathExpression[] = [];
      for (const factor of term.factors) {
        const value = numberValue(factor);
        if (value) {
          coefficient = multiply(coefficient, value);
        } else {
          rest.push(factor);
        }
      }
      if (rest.length === 0) return [coefficient, ONE];
      return [coefficient, rest.length === 1 ? rest[0]! : multiplyExpr(rest)];
    }
    default:
      return [integer(1), term];
  }
}

function rebuild(coefficient: MathNumber, key: MathExpression): MathExpression {
  if (isOneExpr(key)) return num(coefficient);
  if (isOne(coefficient)) return key;
  if (numberEquals(coefficient, integer(-1))) return negate(key);
  return multiplyExpr([num(coefficient), key]);
}

// ---------------------------------------------------------------------------
// Products

function simplifyProduct(rawFactors: MathExpression[]): MathExpression {
  const flattened: MathExpression[] = [];
  let sign = false;
  for (const factor of rawFactors) {
    if (factor.type === "multiply") {
      flattened.push(...factor.factors);
    } else if (factor.type === "negate") {
      // Pull negation out to the front rather than leaving it buried, so
      // `(-x) * (-y)` cancels to `x * y`.
      sign = !sign;
      flattened.push(factor.inner);
    } else {
      flattened.push(factor);
    }
  }

  let coefficient: MathNumber = integer(1);
  // Collect powers with matching bases: x * x^2 → x^3.
  const bases: { base: MathExpression; exponents: MathExpression[] }[] = [];

  for (const factor of flattened) {
    const value = numberValue(factor);
    if (value) {
      coefficient = multiply(coefficient, value);
      continue;
    }
    const [base, exponent] = splitPower(factor);
    const existing = bases.find((entry) => expressionEquals(entry.base, base));
    if (existing) {
      existing.exponents.push(exponent);
    } else {
      bases.push({ base, exponents: [exponent] });
    }
  }

  if (isZero(coefficient)) return ZERO;

  const factors: MathExpression[] = [];
  for (const entry of bases) {
    const exponent = entry.exponents.length === 1 ? entry.exponents[0]! : simplify(addExpr(entry.exponents));
    if (isZeroExpr(exponent)) continue; // x^0 = 1
    if (isOneExpr(exponent)) {
      factors.push(entry.base);
      continue;
    }
    factors.push(powerExpr(entry.base, exponent));
  }

  if (sign) coefficient = negated(coefficient);
  if (factors.length === 0) return num(coefficient);
  if (!isOne(coefficient)) {
    if (numberEquals(coefficient, integer(-1))) {
      return negate(factors.length === 1 ? factors[0]! : multiplyExpr(factors));
    }
    factors.unshift(num(coefficient));
  }
  return factors.length === 1 ? factors[0]! : multiplyExpr(factors);
}

export function splitPower(expression: MathExpression): [MathExpression, MathExpression] {
  if (expression.type === "power") return [expression.base, expression.exponent];
  return [expression, ONE];
}

// ---------------------------------------------------------------------------
// Powers

function simplifyPower(base: MathExpression, exponent: MathExpression): MathExpression {
  if (isZeroExpr(exponent)) return ONE; // x^0 = 1
  if (isOneExpr(exponent)) return base; // x^1 = x
  if (isOneExpr(base)) return ONE; // 1^n = 1
  const exponentValue = numberValue(exponent);
  if (isZeroExpr(base) && exponentValue && !isNegative(exponentValue)) return ZERO;

  // Fold a numeric power only when it stays exact. `2^0.5` must stay
  // symbolic so an exact answer does not silently become a float.
  const baseValue = numberValue(base);
  if (baseValue && exponentValue) {
    const result = raisedTo(baseValue, exponentValue);
    if (isExact(result) || !isExact(baseValue) || !isExact(exponentValue)) {
      return num(result);
    }
  }
  // (x^a)^b = x^(a*b)
  if (base.type === "power") {
    return powerExpr(base.base, simplify(multiplyExpr([base.exponent, exponent])));
  }
  return powerExpr(base, exponent);
}

// ---------------------------------------------------------------------------
// Function folding

/**
 * Fold only where the result is exact or the input was already inexact. This
 * is what keeps `sqrt(2)` symbolic while `sqrt(9)` becomes 3.
 */
function foldFunction(name: MathFunction, value: MathNumber): MathNumber | null {
  if (!functionIsDefined(name, doubleValue(value))) return null;

  const asInt = integerValue(value);
  if (name === "factorial" && asInt !== null && asInt >= 0 && asInt <= 20) {
    let total = 1;
    for (let step = 2; step <= asInt; step++) total *= step;
    return integer(total);
  }
  if (name === "sqrt" && isExact(value)) {
    const exact = raisedTo(value, rational(1, 2));
    return isExact(exact) ? exact : null;
  }
  if (name === "floor" || name === "ceil" || name === "round" || name === "abs") {
    const result = evaluateFunction(name, doubleValue(value));
    return Number.isFinite(result) ? fromDecimal(result) : null;
  }
  // Inexact input already lost exactness, so folding costs nothing.
  if (isExact(value)) return null;
  const result = evaluateFunction(name, doubleValue(value));
  return Number.isFinite(result) ? { kind: "real", value: result } : null;
}

// ---------------------------------------------------------------------------
// Degree

const NON_POLYNOMIAL = Math.floor(Number.MAX_SAFE_INTEGER / 4);

/**
 * Polynomial degree in the given variable (or the highest across all
 * variables when none is named). Drives term ordering and lets the solver
 * pick a strategy.
 */
export function degree(expression: MathExpression, inVariable: string | null = null): number {
  switch (expression.type) {
    case "number":
    case "constant":
      return 0;
    case "variable":
      return inVariable === null || inVariable === expression.name ? 1 : 0;
    case "negate":
      return degree(expression.inner, inVariable);
    case "add":
      return expression.terms.reduce((highest, term) => Math.max(highest, degree(term, inVariable)), 0);
    case "multiply":
      return expression.factors.reduce((total, factor) => total + degree(factor, inVariable), 0);
    case "power": {
      const value = numberValue(expression.exponent);
      const power = value ? integerValue(value) : null;
      if (power === null) {
        // A symbolic exponent is not a polynomial degree; report 0 for a
        // constant base and a large sentinel otherwise so the solver does not
        // mistake it for something it can factor.
        return variablesOf(expression.base).length === 0 ? 0 : NON_POLYNOMIAL;
      }
      return degree(expression.base, inVariable) * power;
    }
    case "function":
      // Any variable inside a transcendental function makes this
      // non-polynomial.
      return expression.args.some((argument) => variablesOf(argument).length > 0) ? NON_POLYNOMIAL : 0;
    case "relation":
      return Math.max(degree(expression.lhs, inVariable), degree(expression.rhs, inVariable));
  }
}

/** True when the expression is a genuine polynomial in `variable`. */
export function isPolynomial(expression: MathExpression, inVariable: string): boolean {
  return degree(expression, inVariable) < NON_POLYNOMIAL / 2;
}
