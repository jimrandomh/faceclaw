// Dense coefficient vector in one variable, `coefficients[i]` multiplying
// `x^i`. Extracting one of these is how the solver decides what technique
// applies — degree 1 is a rearrangement, degree 2 is the quadratic formula,
// higher degrees go to rational-root plus a numeric fallback.

import {
  type MathExpression,
  addExpr,
  constantValue,
  int,
  multiplyExpr,
  negate,
  num,
  powerExpr,
  variable as variableExpr,
} from "./expression";
import {
  type MathNumber,
  add,
  doubleValue,
  greatestCommonDivisor,
  integer,
  integerValue,
  isOne,
  isZero,
  multiply,
  negated,
  numberEquals,
  real,
} from "./math-number";

export class Polynomial {
  readonly coefficients: MathNumber[];
  readonly variable: string;

  constructor(coefficients: MathNumber[], variable: string) {
    this.coefficients = [...coefficients];
    this.variable = variable;
    while (this.coefficients.length > 1 && isZero(this.coefficients[this.coefficients.length - 1]!)) {
      this.coefficients.pop();
    }
    if (this.coefficients.length === 0) this.coefficients.push(integer(0));
  }

  get degree(): number {
    return this.coefficients.length - 1;
  }

  get isZero(): boolean {
    return this.coefficients.every(isZero);
  }

  at(power: number): MathNumber {
    return power < this.coefficients.length ? this.coefficients[power]! : integer(0);
  }

  /**
   * Build from an expression, or null when it is not a polynomial in
   * `variable` (a variable inside `sin`, a symbolic exponent, `1/x`).
   */
  static extract(expression: MathExpression, variable: string): Polynomial | null {
    const coefficients: MathNumber[] = [];
    if (!accumulate(expression, variable, integer(1), coefficients)) return null;
    return new Polynomial(coefficients, variable);
  }

  // -------------------------------------------------------------------------
  // Evaluation

  /**
   * Horner's method — fewer operations and less rounding drift than summing
   * `a_i * x^i` term by term, which matters for the numeric root refinement.
   */
  value(x: number): number {
    let result = 0;
    for (let index = this.coefficients.length - 1; index >= 0; index--) {
      result = result * x + doubleValue(this.coefficients[index]!);
    }
    return result;
  }

  get derivative(): Polynomial {
    if (this.degree <= 0) return new Polynomial([integer(0)], this.variable);
    const derived: MathNumber[] = [];
    for (let power = 1; power <= this.degree; power++) {
      derived.push(multiply(this.at(power), integer(power)));
    }
    return new Polynomial(derived, this.variable);
  }

  expression(): MathExpression {
    const terms: MathExpression[] = [];
    for (let power = this.degree; power >= 0; power--) {
      const coefficient = this.at(power);
      if (isZero(coefficient)) continue;
      let variablePart: MathExpression | null;
      if (power === 0) {
        variablePart = null;
      } else if (power === 1) {
        variablePart = variableExpr(this.variable);
      } else {
        variablePart = powerExpr(variableExpr(this.variable), int(power));
      }
      if (!variablePart) {
        terms.push(num(coefficient));
        continue;
      }
      if (isOne(coefficient)) {
        terms.push(variablePart);
      } else if (numberEquals(coefficient, integer(-1))) {
        terms.push(negate(variablePart));
      } else {
        terms.push(multiplyExpr([num(coefficient), variablePart]));
      }
    }
    if (terms.length === 0) return int(0);
    return terms.length === 1 ? terms[0]! : addExpr(terms);
  }

  /**
   * Divide out a known root, returning the depressed polynomial. Used after a
   * rational root is found so the remainder can be solved in closed form.
   */
  dividingByRoot(root: MathNumber): Polynomial {
    if (this.degree < 1) return this;
    const quotient: MathNumber[] = new Array(this.degree).fill(integer(0));
    let carry: MathNumber = integer(0);
    for (let power = this.degree; power >= 1; power--) {
      const coefficient = add(this.at(power), carry);
      quotient[power - 1] = coefficient;
      carry = multiply(coefficient, root);
    }
    return new Polynomial(quotient, this.variable);
  }

  /**
   * Integer coefficients after clearing denominators, for the rational root
   * theorem. Only meaningful when every coefficient is exact.
   */
  get integerCoefficients(): number[] | null {
    let multiplier = 1;
    for (const coefficient of this.coefficients) {
      if (coefficient.kind === "integer") continue;
      if (coefficient.kind === "real") return null;
      multiplier = (multiplier / greatestCommonDivisor(multiplier, coefficient.d)) * coefficient.d;
      if (multiplier >= 1_000_000) return null;
    }
    const scaled: number[] = [];
    for (const coefficient of this.coefficients) {
      const value = integerValue(multiply(coefficient, integer(multiplier)));
      if (value === null) return null;
      scaled.push(value);
    }
    return scaled;
  }
}

function accumulate(
  expression: MathExpression,
  variable: string,
  scale: MathNumber,
  coefficients: MathNumber[],
): boolean {
  switch (expression.type) {
    case "number":
      addAt(multiply(scale, expression.value), 0, coefficients);
      return true;

    case "constant":
      addAt(multiply(scale, real(constantValue(expression.constant))), 0, coefficients);
      return true;

    case "variable":
      if (expression.name === variable) {
        addAt(scale, 1, coefficients);
        return true;
      }
      // Another free variable makes this not a single-variable polynomial —
      // refuse rather than silently treating it as a constant, which would
      // produce a confidently wrong root.
      return false;

    case "negate":
      return accumulate(expression.inner, variable, negated(scale), coefficients);

    case "add":
      for (const term of expression.terms) {
        if (!accumulate(term, variable, scale, coefficients)) return false;
      }
      return true;

    case "multiply": {
      // Multiply out: each factor must itself be a polynomial, and the
      // product of their coefficient vectors is the result.
      let product: MathNumber[] = [integer(1)];
      for (const factor of expression.factors) {
        const factorCoefficients: MathNumber[] = [];
        if (!accumulate(factor, variable, integer(1), factorCoefficients)) return false;
        product = convolve(product, factorCoefficients);
        if (product.length > 64) return false;
      }
      for (let power = 0; power < product.length; power++) {
        addAt(multiply(scale, product[power]!), power, coefficients);
      }
      return true;
    }

    case "power": {
      const exponentNumber = expression.exponent.type === "number" ? expression.exponent.value : null;
      const power = exponentNumber ? integerValue(exponentNumber) : null;
      if (power === null || power < 0 || power > 32) return false;
      const baseCoefficients: MathNumber[] = [];
      if (!accumulate(expression.base, variable, integer(1), baseCoefficients)) return false;
      let product: MathNumber[] = [integer(1)];
      for (let step = 0; step < power; step++) {
        product = convolve(product, baseCoefficients);
        if (product.length > 64) return false;
      }
      for (let index = 0; index < product.length; index++) {
        addAt(multiply(scale, product[index]!), index, coefficients);
      }
      return true;
    }

    case "function":
    case "relation":
      return false;
  }
}

function addAt(value: MathNumber, power: number, coefficients: MathNumber[]): void {
  while (coefficients.length <= power) coefficients.push(integer(0));
  coefficients[power] = add(coefficients[power]!, value);
}

function convolve(lhs: MathNumber[], rhs: MathNumber[]): MathNumber[] {
  if (lhs.length === 0 || rhs.length === 0) return [integer(0)];
  const result: MathNumber[] = new Array(lhs.length + rhs.length - 1).fill(integer(0));
  for (let i = 0; i < lhs.length; i++) {
    if (isZero(lhs[i]!)) continue;
    for (let j = 0; j < rhs.length; j++) {
      if (isZero(rhs[j]!)) continue;
      result[i + j] = add(result[i + j]!, multiply(lhs[i]!, rhs[j]!));
    }
  }
  return result;
}
