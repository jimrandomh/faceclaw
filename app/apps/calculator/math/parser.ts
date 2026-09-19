// Recursive-descent parser over the token stream.
//
// Grammar, loosest to tightest:
//
//     relation := sum (relop sum)?
//     sum      := product (('+' | '-') product)*
//     product  := unary (('*' | '/' | '%') unary)*
//     unary    := ('-' | '+') unary | power
//     power    := postfix ('^' unary)?          -- right associative
//     postfix  := primary '!'*
//     primary  := number | constant | variable | call | '(' relation ')' | '|' sum '|'
//
// `^` binds tighter than unary minus on its left, so `-x^2` is `-(x^2)` — the
// convention every textbook and every other calculator uses. Getting that
// backwards silently changes the answer, so it has a test.

import { type MathToken, MathParseError, tokenize } from "./lexer";
import {
  type MathExpression,
  type MathFunction,
  type MathConstant,
  ALL_CONSTANTS,
  ALL_FUNCTIONS,
  addExpr,
  constant,
  divideExpr,
  fn,
  int,
  multiplyExpr,
  negate,
  num,
  powerExpr,
  relation,
  subtractExpr,
  variable,
} from "./expression";
import { describeNumber } from "./math-number";
import { normalizeSpoken } from "./normalizer";

/**
 * Guards against a pathological input recursing until the stack dies. A crash
 * on the wearer's face is the worst possible failure mode.
 */
const MAXIMUM_DEPTH = 64;

export function parse(input: string): MathExpression {
  const parser = new Parser(tokenize(input), input);
  const expression = parser.parseRelation();
  parser.expectEnd();
  return expression;
}

/** Parse text that came from speech: normalise first, then parse. */
export function parseSpoken(spoken: string): MathExpression {
  const normalized = normalizeSpoken(spoken);
  if (!normalized) throw new MathParseError({ kind: "emptyInput" }, spoken);
  try {
    return parse(normalized);
  } catch (error) {
    // Report against what the user SAID, not against the normalised form they
    // never typed — otherwise the error quotes machine output.
    if (error instanceof MathParseError) {
      throw new MathParseError(error.errorKind, spoken);
    }
    throw error;
  }
}

class Parser {
  private index = 0;
  private depth = 0;

  constructor(
    private readonly tokens: MathToken[],
    private readonly source: string,
  ) {}

  // -------------------------------------------------------------------------
  // Grammar

  parseRelation(): MathExpression {
    const lhs = this.parseSum();
    const token = this.peek();
    if (!token || token.type !== "relation") return lhs;
    this.advance();
    const rhs = this.parseSum();
    // A chained relation ("1 < x < 5") is a real thing people say, but it is
    // not a single relation node; rejecting it beats silently keeping only
    // half of the constraint.
    if (this.peek()?.type === "relation") {
      throw new MathParseError({ kind: "unexpectedToken", token: "chained comparison" }, this.source);
    }
    return relation(token.relation, lhs, rhs);
  }

  private parseSum(): MathExpression {
    const terms = [this.parseProduct()];
    for (;;) {
      const token = this.peek();
      if (token?.type === "plus") {
        this.advance();
        terms.push(this.parseProduct());
      } else if (token?.type === "minus") {
        this.advance();
        terms.push(negate(this.parseProduct()));
      } else {
        return terms.length === 1 ? terms[0]! : addExpr(terms);
      }
    }
  }

  private parseProduct(): MathExpression {
    let factors = [this.parseUnary()];
    for (;;) {
      const token = this.peek();
      if (token?.type === "star") {
        this.advance();
        factors.push(this.parseUnary());
      } else if (token?.type === "slash") {
        this.advance();
        factors.push(powerExpr(this.parseUnary(), int(-1)));
      } else if (token?.type === "percent") {
        this.advance();
        const divisor = this.parseUnary();
        const dividend = factors.length === 1 ? factors[0]! : multiplyExpr(factors);
        // a mod b == a - b * floor(a / b). Expressed in terms the rest of the
        // engine already handles, so modulo needs no special case in the
        // evaluator, simplifier, or differentiator.
        const quotient = fn("floor", [divideExpr(dividend, divisor)]);
        factors = [subtractExpr(dividend, multiplyExpr([divisor, quotient]))];
      } else {
        return factors.length === 1 ? factors[0]! : multiplyExpr(factors);
      }
    }
  }

  private parseUnary(): MathExpression {
    const token = this.peek();
    if (token?.type === "minus") {
      this.advance();
      return negate(this.parseUnary());
    }
    if (token?.type === "plus") {
      this.advance();
      return this.parseUnary();
    }
    return this.parsePower();
  }

  private parsePower(): MathExpression {
    const base = this.parsePostfix();
    if (this.peek()?.type !== "caret") return base;
    this.advance();
    // Right-associative AND allows a unary exponent: 2^-1, 2^3^2 = 2^(3^2).
    const exponent = this.parseUnary();
    return powerExpr(base, exponent);
  }

  private parsePostfix(): MathExpression {
    let expression = this.parsePrimary();
    while (this.peek()?.type === "bang") {
      this.advance();
      expression = fn("factorial", [expression]);
    }
    return expression;
  }

  private parsePrimary(): MathExpression {
    this.depth += 1;
    try {
      if (this.depth >= MAXIMUM_DEPTH) {
        throw new MathParseError({ kind: "tooComplex" }, this.source);
      }
      const token = this.peek();
      if (!token) throw new MathParseError({ kind: "unexpectedEnd" }, this.source);

      switch (token.type) {
        case "number":
          this.advance();
          return num(token.value);

        case "identifier":
          this.advance();
          return this.parseIdentifier(token.name);

        case "leftParen": {
          this.advance();
          const inner = this.parseRelation();
          this.expect("rightParen");
          return inner;
        }

        case "pipe": {
          // |x| — absolute value. The closing pipe is unambiguous because a
          // bare `|` is not an operator anywhere else in the grammar.
          this.advance();
          const inner = this.parseSum();
          this.expect("pipe");
          return fn("abs", [inner]);
        }

        case "minus":
        case "plus":
          return this.parseUnary();

        default:
          throw new MathParseError({ kind: "unexpectedToken", token: describeToken(token) }, this.source);
      }
    } finally {
      this.depth -= 1;
    }
  }

  private parseIdentifier(name: string): MathExpression {
    const lowered = name.toLowerCase();

    if ((ALL_CONSTANTS as readonly string[]).includes(lowered)) {
      return constant(lowered as MathConstant);
    }
    // `log` with no base means base 10 in ordinary speech, not natural log.
    const resolved = lowered === "log" ? "log10" : lowered;
    if ((ALL_FUNCTIONS as readonly string[]).includes(resolved)) {
      const functionName = resolved as MathFunction;
      // Both `sin(x)` and the spoken-normalised `sin x` must parse.
      if (this.peek()?.type === "leftParen") {
        this.advance();
        const args = [this.parseSum()];
        while (this.peek()?.type === "comma") {
          this.advance();
          args.push(this.parseSum());
        }
        this.expect("rightParen");
        return fn(functionName, args);
      }
      const argument = this.parsePower();
      return fn(functionName, [argument]);
    }

    // A run of single letters from the normaliser ("xy") is a product of
    // variables, not one variable named "xy". Multi-letter names are only
    // honoured when the caller typed them with an underscore or a digit.
    if (lowered.length > 1 && !lowered.includes("_") && !/\d/.test(lowered)) {
      const factors = lowered.split("").map((letter) => variable(letter));
      return multiplyExpr(factors);
    }
    return variable(lowered);
  }

  // -------------------------------------------------------------------------
  // Token plumbing

  private peek(): MathToken | null {
    return this.index < this.tokens.length ? this.tokens[this.index]! : null;
  }

  private advance(): void {
    this.index += 1;
  }

  private expect(type: MathToken["type"]): void {
    const actual = this.peek();
    if (!actual) {
      throw new MathParseError(
        type === "rightParen" ? { kind: "unbalancedParenthesis" } : { kind: "unexpectedEnd" },
        this.source,
      );
    }
    if (actual.type !== type) {
      throw new MathParseError(
        type === "rightParen"
          ? { kind: "unbalancedParenthesis" }
          : { kind: "unexpectedToken", token: describeToken(actual) },
        this.source,
      );
    }
    this.advance();
  }

  expectEnd(): void {
    if (this.index < this.tokens.length) {
      throw new MathParseError(
        { kind: "unexpectedToken", token: describeToken(this.tokens[this.index]!) },
        this.source,
      );
    }
  }
}

function describeToken(token: MathToken): string {
  switch (token.type) {
    case "number":
      return describeNumber(token.value);
    case "identifier":
      return token.name;
    case "plus":
      return "+";
    case "minus":
      return "-";
    case "star":
      return "*";
    case "slash":
      return "/";
    case "percent":
      return "%";
    case "caret":
      return "^";
    case "bang":
      return "!";
    case "leftParen":
      return "(";
    case "rightParen":
      return ")";
    case "pipe":
      return "|";
    case "comma":
      return ",";
    case "relation":
      return token.relation;
  }
}
