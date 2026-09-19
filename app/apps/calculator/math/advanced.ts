// Routes a spoken question to the right advanced-maths topic. Separate from
// the command parser because these questions have a different shape: a
// command is about an EXPRESSION and what to do with it, whereas "is 91
// prime", "factor 360", "area of a circle with radius 3" name a topic and
// carry their own arguments. Trying to force both through one parser made
// the expression grammar swallow phrases it had no business touching.

import { type MathExpression, variablesOf } from "./expression";
import { parseSpoken } from "./parser";
import { applyNumberWords } from "./normalizer";
import { plain } from "./text-renderer";
import { describeNumber, formatInt, fromDecimal } from "./math-number";
import {
  type MathConstantName,
  MAXIMUM_COMPUTED_DIGITS,
  constantDisplayName,
  constantNamed,
  constantSpokenName,
} from "./constant-digits";
import {
  countDigits as countDigitsIn,
  digitsAt,
  expectedFirstPosition,
  findDigits,
  highlightedMatch,
} from "./digit-search";
import { type MathWorkload, longRunOffer as makeLongRunOffer, type LongRunOffer } from "./workload";
import {
  binomial,
  factorizationText,
  fibonacci,
  greatestCommonDivisor,
  integerReport,
  isPrime,
  leastCommonMultiple,
  modularInverse,
} from "./number-theory";
import {
  type Shape,
  pythagoras,
  shapeName,
  shapeSummary,
  triangleAnglesInDegrees,
  triangleArea,
  triangleFromSides,
  triangleKind,
  trianglePerimeter,
} from "./geometry";
import { TRIG_IDENTITIES, familyText, identityMatching, solveTrig } from "./trigonometry";
import { criticalPointText, criticalPoints, limit, limitText, taylor } from "./calculus";
import { definite, integrateWithConstant } from "./symbolic-integral";

// ---------------------------------------------------------------------------
// Topics

export type AdvancedTopic =
  | { kind: "integerReport"; value: number }
  | { kind: "primality"; value: number }
  | { kind: "factorize"; value: number }
  | { kind: "gcd"; a: number; b: number }
  | { kind: "lcm"; a: number; b: number }
  | { kind: "modularInverse"; value: number; modulus: number }
  | { kind: "fibonacci"; n: number }
  | { kind: "binomial"; n: number; k: number }
  | { kind: "symbolicIntegral"; expression: MathExpression; variable: string }
  | { kind: "definiteIntegral"; expression: MathExpression; variable: string; from: number; to: number }
  | { kind: "limit"; expression: MathExpression; variable: string; at: number }
  | { kind: "taylor"; expression: MathExpression; variable: string; order: number }
  | { kind: "criticalPoints"; expression: MathExpression; variable: string }
  | { kind: "trigSolve"; fn: "sin" | "cos" | "tan"; value: number }
  | { kind: "trigIdentity"; query: string }
  /** "where does 11 first appear in pi" */
  | { kind: "digitSearch"; pattern: string; constant: MathConstantName; occurrence: number }
  /** "how many times does 42 appear in pi" */
  | { kind: "digitCount"; pattern: string; constant: MathConstantName }
  /** "what are digits 100 to 110 of pi" */
  | { kind: "digitsAt"; constant: MathConstantName; from: number; to: number }
  | { kind: "shapeArea"; shape: Shape }
  | { kind: "triangleFromSides"; a: number; b: number; c: number }
  | { kind: "pythagoras"; a: number | null; b: number | null; c: number | null };

export type AdvancedAnswer = {
  headline: string;
  detail: string;
  /** Extra rows for the answer view, and for a longer readback. */
  fields: [string, string][];
  /**
   * Set when this answer is only as good as the fast expansion allowed, and
   * a deeper opted-in run would do better. The router itself never starts
   * one: it is pure and synchronous, and the wait is a decision belonging to
   * the caller.
   */
  unresolvedWorkload: MathWorkload | null;
};

// ---------------------------------------------------------------------------
// Parsing

/**
 * null when the utterance is not an advanced-maths question, so the caller
 * can fall through to the ordinary expression path.
 */
export function parseAdvanced(utterance: string): AdvancedTopic | null {
  const text = applyNumberWords(utterance.toLowerCase()).replace(/^[ .,!?]+|[ .,!?]+$/g, "");

  // Constants first: "the first 11 in pi" contains digits and the word "in",
  // which the geometry and number-theory matchers would both take a swing at.
  const constantTopic = parseConstantDigits(text);
  if (constantTopic) return constantTopic;
  const numberTopic = parseNumberTheory(text);
  if (numberTopic) return numberTopic;
  const calculusTopic = parseCalculus(text, utterance);
  if (calculusTopic) return calculusTopic;
  const trigTopic = parseTrigonometry(text);
  if (trigTopic) return trigTopic;
  return parseGeometry(text);
}

// Constant digits ------------------------------------------------------------

function parseConstantDigits(text: string): AdvancedTopic | null {
  // Must name a constant AND talk about its expansion, or "area of a circle"
  // (which contains pi implicitly) would land here.
  const constant = constantNamed(text);
  if (!constant) return null;
  const mentionsDigits =
    text.includes("digit") ||
    text.includes("appear") ||
    text.includes("occur") ||
    text.includes("within") ||
    text.includes("inside") ||
    text.includes("expansion") ||
    text.includes("decimal place") ||
    text.includes("position") ||
    text.includes("show up") ||
    text.includes("found in");
  if (!mentionsDigits) return null;

  const numbers = allInts(text);

  // "digits 100 to 110 of pi"
  if (
    text.includes("digit") &&
    text.includes(" to ") &&
    numbers.length >= 2 &&
    !text.includes("appear") &&
    !text.includes("occur")
  ) {
    const sorted = [numbers[0]!, numbers[1]!].sort((a, b) => a - b);
    return { kind: "digitsAt", constant, from: sorted[0]!, to: sorted[1]! };
  }

  // "how many times does 42 appear"
  if (text.includes("how many") || text.includes("count")) {
    const pattern = numbers[0];
    if (pattern === undefined) return null;
    return { kind: "digitCount", pattern: String(pattern), constant };
  }

  const pattern = numbers[0];
  if (pattern === undefined) return null;
  // "the third time 11 appears"
  const occurrence = ordinalIn(text) ?? 1;
  return { kind: "digitSearch", pattern: String(pattern), constant, occurrence };
}

/**
 * "3rd", not "3th". Cheap to get right and jarring to get wrong on a line
 * someone reads aloud.
 */
export function ordinalWord(value: number): string {
  switch (value) {
    case 1:
      return "first";
    case 2:
      return "second";
    case 3:
      return "third";
    default:
      break;
  }
  let suffix: string;
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 === 11 || mod100 === 12 || mod100 === 13) suffix = "th";
  else if (mod10 === 1) suffix = "st";
  else if (mod10 === 2) suffix = "nd";
  else if (mod10 === 3) suffix = "rd";
  else suffix = "th";
  return `${value}${suffix}`;
}

function ordinalIn(text: string): number | null {
  const words: [string, number][] = [
    ["first", 1],
    ["second", 2],
    ["third", 3],
    ["fourth", 4],
    ["fifth", 5],
    ["sixth", 6],
    ["seventh", 7],
    ["eighth", 8],
    ["ninth", 9],
    ["tenth", 10],
  ];
  for (const [word, value] of words) {
    if (text.includes(word)) return value;
  }
  return null;
}

// Number theory --------------------------------------------------------------

function parseNumberTheory(text: string): AdvancedTopic | null {
  if (text.includes("prime") && !text.includes("factor")) {
    const value = firstInt(text);
    if (value !== null) return { kind: "primality", value };
  }
  if (text.includes("factor")) {
    const value = firstInt(text);
    if (value !== null) return { kind: "factorize", value };
  }
  if (text.includes("gcd") || text.includes("greatest common") || text.includes("highest common")) {
    const values = allInts(text);
    if (values.length >= 2) return { kind: "gcd", a: values[0]!, b: values[1]! };
  }
  if (
    text.includes("lcm") ||
    text.includes("lowest common multiple") ||
    text.includes("least common multiple")
  ) {
    const values = allInts(text);
    if (values.length >= 2) return { kind: "lcm", a: values[0]!, b: values[1]! };
  }
  if (text.includes("inverse") && text.includes("mod")) {
    const values = allInts(text);
    if (values.length >= 2) return { kind: "modularInverse", value: values[0]!, modulus: values[1]! };
  }
  if (text.includes("fibonacci")) {
    const value = firstInt(text);
    if (value !== null) return { kind: "fibonacci", n: value };
  }
  if (text.includes("choose") || text.includes("binomial") || text.includes("combinations")) {
    const values = allInts(text);
    if (values.length >= 2) return { kind: "binomial", n: values[0]!, k: values[1]! };
  }
  if (text.includes("tell me about") || text.includes("facts about")) {
    const value = firstInt(text);
    if (value !== null) return { kind: "integerReport", value };
  }
  return null;
}

// Calculus -------------------------------------------------------------------

function parseCalculus(text: string, original: string): AdvancedTopic | null {
  if (text.includes("integral") || text.includes("integrate") || text.includes("antiderivative")) {
    const expression = expressionTail(original, ["integral of", "integrate", "antiderivative of", "integral"]);
    if (!expression) return null;
    const variable = variablesOf(expression)[0] ?? "x";
    const bounds = boundsIn(text);
    if (bounds) {
      return { kind: "definiteIntegral", expression, variable, from: bounds[0], to: bounds[1] };
    }
    return { kind: "symbolicIntegral", expression, variable };
  }

  if (text.includes("limit")) {
    const expression = expressionTail(original, ["limit of", "the limit of", "limit"]);
    if (!expression) return null;
    // "as x approaches 0"
    const point = firstDoubleAfter(["approaches", "approaching", "tends to", "goes to"], text) ?? 0;
    return { kind: "limit", expression, variable: variablesOf(expression)[0] ?? "x", at: point };
  }

  if (text.includes("taylor") || text.includes("maclaurin") || text.includes("series")) {
    const expression = expressionTail(original, [
      "series of",
      "series for",
      "expansion of",
      "taylor",
      "maclaurin",
    ]);
    if (!expression) return null;
    const orderValue = firstDoubleAfter(["order", "to order", "terms"], text);
    const order = orderValue !== null ? Math.trunc(orderValue) : 5;
    return { kind: "taylor", expression, variable: variablesOf(expression)[0] ?? "x", order };
  }

  if (
    text.includes("critical point") ||
    text.includes("turning point") ||
    text.includes("maximum") ||
    text.includes("minimum") ||
    text.includes("extrema")
  ) {
    const expression = expressionTail(original, [
      "critical points of",
      "turning points of",
      "extrema of",
      "maximum of",
      "minimum of",
      "of",
    ]);
    if (!expression) return null;
    return { kind: "criticalPoints", expression, variable: variablesOf(expression)[0] ?? "x" };
  }
  return null;
}

// Trigonometry ---------------------------------------------------------------

function parseTrigonometry(text: string): AdvancedTopic | null {
  if (text.includes("identity") || text.includes("law of")) {
    return { kind: "trigIdentity", query: text };
  }
  // "solve sin x = 0.5"
  for (const name of ["sin", "cos", "tan"] as const) {
    if (!text.includes(name)) continue;
    if (!text.includes("=") && !text.includes("equals")) continue;
    const value = lastDouble(text);
    if (value === null) continue;
    return { kind: "trigSolve", fn: name, value };
  }
  return null;
}

// Geometry -------------------------------------------------------------------

function parseGeometry(text: string): AdvancedTopic | null {
  const numbers = allDoubles(text);

  if (text.includes("pythagoras") || text.includes("hypotenuse")) {
    if (numbers.length < 2) return null;
    return text.includes("hypotenuse") && text.includes("find")
      ? { kind: "pythagoras", a: numbers[0]!, b: numbers[1]!, c: null }
      : { kind: "pythagoras", a: numbers[0]!, b: null, c: numbers[1]! };
  }
  if (text.includes("triangle") && numbers.length >= 3 && text.includes("side")) {
    return { kind: "triangleFromSides", a: numbers[0]!, b: numbers[1]!, c: numbers[2]! };
  }

  // Shapes, longest name first so "rectangular prism" is not read as
  // "rectangle".
  const shapes: [string, (values: number[]) => Shape | null][] = [
    [
      "rectangular prism",
      (values) =>
        values.length >= 3
          ? { kind: "rectangularPrism", length: values[0]!, width: values[1]!, height: values[2]! }
          : null,
    ],
    ["sphere", (values) => (values.length >= 1 ? { kind: "sphere", radius: values[0]! } : null)],
    [
      "cylinder",
      (values) => (values.length >= 2 ? { kind: "cylinder", radius: values[0]!, height: values[1]! } : null),
    ],
    ["cone", (values) => (values.length >= 2 ? { kind: "cone", radius: values[0]!, height: values[1]! } : null)],
    ["cube", (values) => (values.length >= 1 ? { kind: "cube", side: values[0]! } : null)],
    ["circle", (values) => (values.length >= 1 ? { kind: "circle", radius: values[0]! } : null)],
    [
      "rectangle",
      (values) => (values.length >= 2 ? { kind: "rectangle", width: values[0]!, height: values[1]! } : null),
    ],
    ["square", (values) => (values.length >= 1 ? { kind: "square", side: values[0]! } : null)],
    [
      "trapezoid",
      (values) =>
        values.length >= 3 ? { kind: "trapezoid", a: values[0]!, b: values[1]!, height: values[2]! } : null,
    ],
    ["ellipse", (values) => (values.length >= 2 ? { kind: "ellipse", a: values[0]!, b: values[1]! } : null)],
  ];
  const wantsMeasurement =
    text.includes("area") ||
    text.includes("volume") ||
    text.includes("perimeter") ||
    text.includes("circumference") ||
    text.includes("surface");
  if (!wantsMeasurement) return null;
  for (const [name, build] of shapes) {
    if (!text.includes(name)) continue;
    const shape = build(numbers);
    if (shape) return { kind: "shapeArea", shape };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Answering

export function answerAdvanced(topic: AdvancedTopic): AdvancedAnswer {
  switch (topic.kind) {
    case "integerReport": {
      const report = integerReport(topic.value);
      const fields: [string, string][] = [
        ["Prime", report.isPrime ? "yes" : "no"],
        ["Factorisation", factorizationText(report)],
        ["Divisors", String(report.divisorCount)],
        ["Divisor sum", String(report.divisorSum)],
        ["Totient", String(report.totient)],
        ["Digit sum", String(report.digitSum)],
        ["Digital root", String(report.digitalRoot)],
      ];
      if (report.isPerfect) fields.push(["Perfect", "yes"]);
      return answer(
        `${topic.value} = ${factorizationText(report)}`,
        `${topic.value} is ${report.isPrime ? "prime" : "composite"}, ` +
          `with ${report.divisorCount} divisors summing to ${report.divisorSum}.`,
        fields,
      );
    }

    case "primality": {
      const prime = isPrime(topic.value);
      const report = prime ? "" : factorizationText(integerReport(topic.value));
      return answer(
        `${topic.value} is ${prime ? "prime" : "not prime"}`,
        prime
          ? `${topic.value} has no divisors other than 1 and itself.`
          : `${topic.value} = ${report}.`,
      );
    }

    case "factorize": {
      const report = integerReport(topic.value);
      return answer(
        `${topic.value} = ${factorizationText(report)}`,
        `${topic.value} factors into ${factorizationText(report)}.`,
      );
    }

    case "gcd": {
      const gcd = greatestCommonDivisor(topic.a, topic.b);
      return answer(
        `gcd(${topic.a}, ${topic.b}) = ${gcd}`,
        `The greatest common divisor of ${topic.a} and ${topic.b} is ${gcd}.`,
      );
    }

    case "lcm": {
      const lcm = leastCommonMultiple(topic.a, topic.b);
      return answer(
        `lcm(${topic.a}, ${topic.b}) = ${lcm}`,
        `The least common multiple of ${topic.a} and ${topic.b} is ${lcm}.`,
      );
    }

    case "modularInverse": {
      const inverse = modularInverse(topic.value, topic.modulus);
      if (inverse === null) {
        return answer(
          "No inverse",
          `${topic.value} and ${topic.modulus} share a factor, so no modular inverse exists.`,
        );
      }
      return answer(
        `${topic.value}⁻¹ ≡ ${inverse} (mod ${topic.modulus})`,
        `${topic.value} × ${inverse} ≡ 1 (mod ${topic.modulus}).`,
      );
    }

    case "fibonacci": {
      const value = fibonacci(topic.n);
      if (value === null) {
        return answer("Too large", `F(${topic.n}) does not fit in an exact integer.`);
      }
      return answer(`F(${topic.n}) = ${value}`, `The ${topic.n}th Fibonacci number is ${value}.`);
    }

    case "binomial": {
      const value = binomial(topic.n, topic.k);
      if (value === null) {
        return answer("Undefined", `${topic.n} choose ${topic.k} is not defined.`);
      }
      return answer(
        `C(${topic.n}, ${topic.k}) = ${value}`,
        `There are ${value} ways to choose ${topic.k} from ${topic.n}.`,
      );
    }

    case "symbolicIntegral": {
      const antiderivative = integrateWithConstant(topic.expression, topic.variable);
      if (!antiderivative) {
        return answer(
          "No closed form",
          "This has no elementary antiderivative that this build can find. " +
            "Ask for a definite integral and it will be computed numerically.",
        );
      }
      return answer(
        `∫ = ${plain(antiderivative)}`,
        `∫ ${plain(topic.expression)} d${topic.variable} = ${plain(antiderivative)}`,
      );
    }

    case "definiteIntegral": {
      const result = definite(topic.expression, topic.variable, topic.from, topic.to);
      switch (result.kind) {
        case "exact":
          return answer(
            `∫ = ${describeNumber(result.value)}`,
            `Using F = ${plain(result.antiderivative)}, the definite integral is ${describeNumber(result.value)}.`,
          );
        case "numeric":
          return answer(
            `∫ ≈ ${describeNumber(fromDecimal(result.value))}`,
            "No closed form was found, so this was integrated numerically.",
          );
        case "failed":
          return answer("Could not integrate", result.reason);
      }
      break;
    }

    case "limit": {
      const result = limit(topic.expression, topic.variable, topic.at);
      let detail =
        `As ${topic.variable} → ${format(topic.at)}, ` +
        `${plain(topic.expression)} → ${limitText(result)}.`;
      if (result.kind === "doesNotExist") {
        detail =
          `The one-sided limits disagree ` +
          `(${format(result.left ?? 0)} from the left, ${format(result.right ?? 0)} from the right), ` +
          `so the limit does not exist.`;
      }
      return answer(`limit = ${limitText(result)}`, detail);
    }

    case "taylor": {
      const series = taylor(topic.expression, topic.variable, topic.order);
      if (!series) {
        return answer("No series", "Could not expand that about 0.");
      }
      return answer(
        plain(series),
        `${plain(topic.expression)} ≈ ${plain(series)} to order ${topic.order}.`,
      );
    }

    case "criticalPoints": {
      const points = criticalPoints(topic.expression, topic.variable);
      if (points.length === 0) {
        return answer("No critical points", "The derivative never vanishes in the search window.");
      }
      return answer(
        points
          .slice(0, 2)
          .map(criticalPointText)
          .join(", "),
        points.map(criticalPointText).join("; "),
        points.map((point) => [
          point.kind.charAt(0).toUpperCase() + point.kind.slice(1),
          `(${format(point.x)}, ${format(point.y)})`,
        ]),
      );
    }

    case "trigSolve": {
      const solution = solveTrig(topic.fn, topic.value);
      switch (solution.kind) {
        case "none":
          return answer("No solution", `${topic.fn} never reaches ${format(topic.value)}.`);
        case "all":
          return answer("True for every angle", "Any value works.");
        case "families": {
          const text = solution.families.map(familyText).join(",  ");
          return answer(
            `x = ${text}`,
            `${topic.fn} x = ${format(topic.value)} for x = ${text}, where n is any integer.`,
            solution.families.map((family, index) => [`Family ${index + 1}`, familyText(family)]),
          );
        }
      }
      break;
    }

    case "trigIdentity": {
      const identity = identityMatching(topic.query);
      if (!identity) {
        return answer(
          "Not in the sheet",
          "Known identities: " + TRIG_IDENTITIES.map((entry) => entry.name).join(", "),
        );
      }
      return answer(identity.plain, `${identity.name}: ${identity.plain}`);
    }

    case "digitSearch": {
      const outcome = findDigits(topic.pattern, topic.constant, topic.occurrence);
      switch (outcome.kind) {
        case "invalidPattern":
          return answer("Cannot search", outcome.reason);
        case "notFound": {
          // "Not in pi" and "not in the first 10,000 digits of pi" are very
          // different claims, and only the second one is true.
          let detail =
            `${topic.pattern} does not appear in the first ` +
            `${formatInt(outcome.searchedDigits)} digits of ${constantSpokenName(topic.constant)}.`;
          const expected = expectedFirstPosition(topic.pattern.length);
          if (expected !== null && expected > outcome.searchedDigits) {
            const article = [8, 11, 18].includes(topic.pattern.length) ? "An" : "A";
            detail +=
              ` ${article} ${topic.pattern.length}-digit run turns up around the ` +
              `${formatInt(expected)}th place on average, so this needs a deeper expansion.`;
          }
          return {
            headline: `Not in the first ${formatInt(outcome.searchedDigits)} digits`,
            detail,
            fields: [],
            unresolvedWorkload: {
              kind: "digitSearch",
              constant: topic.constant,
              pattern: topic.pattern,
              occurrence: topic.occurrence,
            },
          };
        }
        case "found": {
          const match = outcome.match;
          const ordinalText = ordinalWord(topic.occurrence);
          const places =
            match.start === match.end ? `place ${match.start}` : `places ${match.start}–${match.end}`;
          return answer(
            `${constantDisplayName(topic.constant)}: ${places}`,
            `The ${ordinalText} appearance of ${topic.pattern} in ${constantSpokenName(topic.constant)} ` +
              `is at decimal ${places}, in …${highlightedMatch(match)}…`,
            [
              ["Start", String(match.start)],
              ["End", String(match.end)],
              ["Context", highlightedMatch(match)],
            ],
          );
        }
      }
      break;
    }

    case "digitCount": {
      const counted = countDigitsIn(topic.pattern, topic.constant);
      return {
        headline: `${counted.occurrences} time${counted.occurrences === 1 ? "" : "s"}`,
        detail:
          `${topic.pattern} appears ${counted.occurrences} time${counted.occurrences === 1 ? "" : "s"} ` +
          `in the first ${formatInt(counted.searchedDigits)} digits of ${constantSpokenName(topic.constant)}.`,
        fields: [["Searched", `${formatInt(counted.searchedDigits)} digits`]],
        unresolvedWorkload: { kind: "digitCount", constant: topic.constant, pattern: topic.pattern },
      };
    }

    case "digitsAt": {
      if (topic.to - topic.from >= 200) {
        return answer("Too many digits", "Ask for a span under 200 digits.");
      }
      const digits = digitsAt(topic.constant, topic.from, topic.to);
      if (!digits) {
        return {
          headline: "Out of range",
          detail:
            `That is past the ${formatInt(MAXIMUM_COMPUTED_DIGITS)} ` +
            `digits computed on device.`,
          fields: [],
          unresolvedWorkload: { kind: "constantDigits", constant: topic.constant, count: topic.to },
        };
      }
      return answer(
        digits,
        `Decimal places ${topic.from}–${topic.to} of ${constantSpokenName(topic.constant)} are ${digits}.`,
        [["Places", `${topic.from}–${topic.to}`]],
      );
    }

    case "shapeArea": {
      const parts = shapeSummary(topic.shape);
      if (parts.length === 0) {
        return answer("Not enough measurements", "That shape needs more values.");
      }
      return answer(
        parts.map(([label, value]) => `${label} ${format(value)}`).join(", "),
        `For that ${shapeName(topic.shape)}: ` +
          parts.map(([label, value]) => `${label.toLowerCase()} ${format(value)}`).join(", ") +
          ".",
        parts.map(([label, value]) => [label, format(value)]),
      );
    }

    case "triangleFromSides": {
      const result = triangleFromSides(topic.a, topic.b, topic.c);
      switch (result.kind) {
        case "impossible":
          return answer("No such triangle", result.reason);
        case "one":
        case "two": {
          const triangle = result.kind === "one" ? result.triangle : result.first;
          const [angleA, angleB, angleC] = triangleAnglesInDegrees(triangle);
          return answer(
            `Area ${format(triangleArea(triangle))}, ${triangleKind(triangle)}`,
            `Angles ${format(angleA)}°, ${format(angleB)}°, ${format(angleC)}°; ` +
              `area ${format(triangleArea(triangle))}; perimeter ${format(trianglePerimeter(triangle))}.`,
            [
              ["Angle A", `${format(angleA)}°`],
              ["Angle B", `${format(angleB)}°`],
              ["Angle C", `${format(angleC)}°`],
              ["Area", format(triangleArea(triangle))],
              ["Perimeter", format(trianglePerimeter(triangle))],
              ["Type", triangleKind(triangle)],
            ],
          );
        }
      }
      break;
    }

    case "pythagoras": {
      const missing = pythagoras(topic.a, topic.b, topic.c);
      if (missing === null) {
        return answer(
          "Cannot solve",
          "Give two of the three sides, and a leg must be shorter than the hypotenuse.",
        );
      }
      return answer(format(missing), `The missing side is ${format(missing)}.`);
    }
  }
}

function answer(headline: string, detail: string, fields: [string, string][] = []): AdvancedAnswer {
  return { headline, detail, fields, unresolvedWorkload: null };
}

// ---------------------------------------------------------------------------
// Extraction helpers

export function firstInt(text: string): number | null {
  return allInts(text)[0] ?? null;
}

export function allInts(text: string): number[] {
  return (text.match(/-?\d+/g) ?? []).map(Number).filter(Number.isSafeInteger);
}

export function allDoubles(text: string): number[] {
  return (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite);
}

export function lastDouble(text: string): number | null {
  const values = allDoubles(text);
  return values.length > 0 ? values[values.length - 1]! : null;
}

function firstDoubleAfter(keywords: string[], text: string): number | null {
  for (const keyword of keywords) {
    const index = text.indexOf(keyword);
    if (index < 0) continue;
    const tail = text.slice(index + keyword.length);
    const value = allDoubles(tail)[0];
    if (value !== undefined) return value;
  }
  return null;
}

/** "from 0 to 5" */
export function boundsIn(text: string): [number, number] | null {
  const match = text.match(/from\s+(-?[0-9.]+)\s+to\s+(-?[0-9.]+)/);
  if (!match) return null;
  const lower = Number(match[1]);
  const upper = Number(match[2]);
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
  return [lower, upper];
}

/** Take everything after the topic keyword and parse it as an expression. */
function expressionTail(original: string, keywords: string[]): MathExpression | null {
  const lowered = original.toLowerCase();
  for (const keyword of [...keywords].sort((a, b) => b.length - a.length)) {
    const index = lowered.indexOf(keyword);
    if (index < 0) continue;
    let tail = original.slice(index + keyword.length);
    // Drop trailing clauses that belong to the command, not the maths.
    for (const terminator of [" from ", " as ", " with respect to ", " to order ", " dx"]) {
      const cut = tail.toLowerCase().indexOf(terminator);
      if (cut >= 0) tail = tail.slice(0, cut);
    }
    const trimmed = tail.replace(/^[ .,?]+|[ .,?]+$/g, "");
    if (!trimmed) continue;
    try {
      return parseSpoken(trimmed);
    } catch {
      continue;
    }
  }
  return null;
}

function format(value: number): string {
  return describeNumber(fromDecimal(value));
}
