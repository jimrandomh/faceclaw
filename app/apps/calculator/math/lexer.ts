// Tokeniser for typed and normalised spoken maths expressions.

import { type MathNumber, fromDecimal, integer, real } from "./math-number";
import { type MathRelation } from "./expression";
import { isLetter } from "../../../util/unicode-class";

export type MathToken =
  | { type: "number"; value: MathNumber }
  | { type: "identifier"; name: string }
  | { type: "plus" }
  | { type: "minus" }
  | { type: "star" }
  | { type: "slash" }
  | { type: "percent" }
  | { type: "caret" }
  | { type: "bang" }
  | { type: "leftParen" }
  | { type: "rightParen" }
  | { type: "pipe" }
  | { type: "comma" }
  | { type: "relation"; relation: MathRelation };

export type MathParseErrorKind =
  | { kind: "unexpectedCharacter"; character: string }
  | { kind: "unexpectedToken"; token: string }
  | { kind: "unexpectedEnd" }
  | { kind: "unbalancedParenthesis" }
  | { kind: "unknownFunction"; name: string }
  | { kind: "emptyInput" }
  | { kind: "tooComplex" };

/**
 * A parse failure with the user's own words attached, so an error can quote
 * back what was actually said rather than leaving the wearer guessing which
 * word broke.
 */
export class MathParseError extends Error {
  readonly errorKind: MathParseErrorKind;
  /** What the user actually said. */
  readonly context: string;

  constructor(errorKind: MathParseErrorKind, context = "") {
    super(describeParseError(errorKind, context));
    this.name = "MathParseError";
    this.errorKind = errorKind;
    this.context = context;
  }
}

/** Written for someone reading a lens mid-task, not for a log. */
export function describeParseError(kind: MathParseErrorKind, context: string): string {
  const quoted = context ? `“${context}”` : "that expression";
  switch (kind.kind) {
    case "unexpectedCharacter":
      return `Could not read "${kind.character}" in ${quoted}`;
    case "unexpectedToken":
      return `Did not expect "${kind.token}" in ${quoted}`;
    case "unexpectedEnd":
      return `${quoted} is incomplete`;
    case "unbalancedParenthesis":
      return `Brackets do not balance in ${quoted}`;
    case "unknownFunction":
      return `"${kind.name}" is not a function this build knows`;
    case "emptyInput":
      return "Nothing to solve";
    case "tooComplex":
      return "That expression is too deeply nested";
  }
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

export function tokenize(input: string): MathToken[] {
  const tokens: MathToken[] = [];
  const characters = Array.from(input);
  let index = 0;

  while (index < characters.length) {
    const character = characters[index]!;

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (isDigit(character) || (character === "." && index + 1 < characters.length && isDigit(characters[index + 1]!))) {
      let literal = "";
      let sawDot = false;
      while (index < characters.length) {
        const next = characters[index]!;
        if (isDigit(next)) {
          literal += next;
        } else if (next === "." && !sawDot) {
          sawDot = true;
          literal += next;
        } else if (next === "," && index + 1 < characters.length && isDigit(characters[index + 1]!)) {
          // Thousands separator inside a literal: 1,000
          index += 1;
          continue;
        } else {
          break;
        }
        index += 1;
      }
      // Decimals become exact rationals so later arithmetic stays exact:
      // 0.25 behaves as 1/4, not as a float.
      if (sawDot) {
        tokens.push({ type: "number", value: fromDecimal(Number(literal) || 0) });
      } else {
        const parsed = Number(literal);
        // Exact for every safe literal; anything larger degrades to a real
        // instead of losing digits silently.
        tokens.push({
          type: "number",
          value: Number.isSafeInteger(parsed) ? integer(parsed) : real(parsed),
        });
      }
      continue;
    }

    if (isLetter(character) || character === "_") {
      let name = "";
      while (
        index < characters.length &&
        (isLetter(characters[index]!) || isDigit(characters[index]!) || characters[index] === "_")
      ) {
        name += characters[index];
        index += 1;
      }
      tokens.push({ type: "identifier", name });
      continue;
    }

    switch (character) {
      case "+":
        tokens.push({ type: "plus" });
        break;
      case "-":
      case "−": // ASCII and Unicode minus
        tokens.push({ type: "minus" });
        break;
      case "*":
      case "×":
      case "⋅":
        tokens.push({ type: "star" });
        break;
      case "/":
      case "÷":
        tokens.push({ type: "slash" });
        break;
      case "%":
        tokens.push({ type: "percent" });
        break;
      case "^":
        tokens.push({ type: "caret" });
        break;
      case "!":
        tokens.push({ type: "bang" });
        break;
      case "(":
      case "[":
      case "{":
        tokens.push({ type: "leftParen" });
        break;
      case ")":
      case "]":
      case "}":
        tokens.push({ type: "rightParen" });
        break;
      case "|":
        tokens.push({ type: "pipe" });
        break;
      case ",":
        tokens.push({ type: "comma" });
        break;
      case "=":
        // "==" from a typed source is still equality.
        if (index + 1 < characters.length && characters[index + 1] === "=") index += 1;
        tokens.push({ type: "relation", relation: "=" });
        break;
      case "<":
        if (index + 1 < characters.length && characters[index + 1] === "=") {
          tokens.push({ type: "relation", relation: "<=" });
          index += 1;
        } else {
          tokens.push({ type: "relation", relation: "<" });
        }
        break;
      case ">":
        if (index + 1 < characters.length && characters[index + 1] === "=") {
          tokens.push({ type: "relation", relation: ">=" });
          index += 1;
        } else {
          tokens.push({ type: "relation", relation: ">" });
        }
        break;
      case "≤":
        tokens.push({ type: "relation", relation: "<=" });
        break;
      case "≥":
        tokens.push({ type: "relation", relation: ">=" });
        break;
      case "√":
        tokens.push({ type: "identifier", name: "sqrt" });
        break;
      case "π":
        tokens.push({ type: "identifier", name: "pi" });
        break;
      default:
        throw new MathParseError({ kind: "unexpectedCharacter", character }, input);
    }
    index += 1;
  }

  if (tokens.length === 0) throw new MathParseError({ kind: "emptyInput" }, input);
  return tokens;
}
