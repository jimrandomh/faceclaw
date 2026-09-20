// The glasses have no formula renderer and a 576-pixel-wide window, so every
// expression needs a compact ASCII form. Two things make this more than a
// tree walk. First, the internal representation is deliberately uniform —
// division is `a · b^-1`, subtraction is `a + (−b)` — and printing that
// literally would produce `2*x^-1` where a reader expects `2/x`, so the
// renderer detects those patterns and un-normalises them. Second, precedence
// decides bracketing: too few brackets is wrong, too many is unreadable.

import { type MathExpression, numberValue } from "./expression";
import { type MathNumber, describeNumber, isNegative, isOne, negated } from "./math-number";

const PRECEDENCE = {
  relation: 1,
  sum: 2,
  product: 3,
  power: 4,
} as const;

export function plain(expression: MathExpression): string {
  return render(expression, 0);
}

export function renderNumber(value: MathNumber): string {
  return describeNumber(value);
}

function render(expression: MathExpression, parentPrecedence: number): string {
  switch (expression.type) {
    case "number": {
      const text = describeNumber(expression.value);
      return wrap(text, isNegative(expression.value) && parentPrecedence >= PRECEDENCE.product);
    }

    case "variable":
      return expression.name;

    case "constant":
      return expression.constant;

    case "negate":
      return wrap("-" + render(expression.inner, PRECEDENCE.product), parentPrecedence > PRECEDENCE.sum);

    case "add": {
      let output = "";
      for (let index = 0; index < expression.terms.length; index++) {
        const term = expression.terms[index]!;
        if (term.type === "negate") {
          output += index === 0 ? "-" : " - ";
          output += render(term.inner, PRECEDENCE.sum);
          continue;
        }
        const value = numberValue(term);
        if (value && isNegative(value) && index > 0) {
          output += " - " + describeNumber(negated(value));
          continue;
        }
        if (index > 0) output += " + ";
        output += render(term, PRECEDENCE.sum);
      }
      return wrap(output, parentPrecedence > PRECEDENCE.sum);
    }

    case "multiply": {
      const numerator: MathExpression[] = [];
      const denominator: MathExpression[] = [];
      for (const factor of expression.factors) {
        if (factor.type === "power") {
          const power = numberValue(factor.exponent);
          if (power && isNegative(power)) {
            const positive = negated(power);
            denominator.push(
              isOne(positive) ? factor.base : { type: "power", base: factor.base, exponent: { type: "number", value: positive } },
            );
            continue;
          }
        }
        numerator.push(factor);
      }
      const top =
        numerator.length === 0
          ? "1"
          : numerator.map((factor) => render(factor, PRECEDENCE.product)).join("*");
      if (denominator.length === 0) {
        return wrap(top, parentPrecedence > PRECEDENCE.product);
      }
      const bottom = denominator.map((factor) => render(factor, PRECEDENCE.power)).join("*");
      return wrap(`${top}/${bottom}`, parentPrecedence > PRECEDENCE.product);
    }

    case "power": {
      const exponentValue = numberValue(expression.exponent);
      if (exponentValue && exponentValue.kind === "rational" && exponentValue.n === 1 && exponentValue.d === 2) {
        return `sqrt(${render(expression.base, 0)})`;
      }
      // A bare negative power is a reciprocal. Printing `x^(-1)` where a
      // reader expects `1/x` is the plain-text twin of the fraction
      // un-normalisation above.
      if (exponentValue && isNegative(exponentValue)) {
        const positive = negated(exponentValue);
        const inner = isOne(positive)
          ? render(expression.base, PRECEDENCE.power)
          : `${render(expression.base, PRECEDENCE.power + 1)}^${describeNumber(positive)}`;
        return wrap(`1/${inner}`, parentPrecedence > PRECEDENCE.product);
      }
      const body =
        `${render(expression.base, PRECEDENCE.power + 1)}` +
        `^${render(expression.exponent, PRECEDENCE.power + 1)}`;
      return wrap(body, parentPrecedence > PRECEDENCE.power);
    }

    case "function": {
      const inner = expression.args.map((argument) => render(argument, 0)).join(", ");
      if (expression.fn === "factorial") return `(${inner})!`;
      if (expression.fn === "abs") return `|${inner}|`;
      return `${expression.fn}(${inner})`;
    }

    case "relation":
      return (
        `${render(expression.lhs, PRECEDENCE.relation)} ` +
        `${expression.relation} ` +
        `${render(expression.rhs, PRECEDENCE.relation)}`
      );
  }
}

function wrap(body: string, condition: boolean): string {
  return condition ? `(${body})` : body;
}
