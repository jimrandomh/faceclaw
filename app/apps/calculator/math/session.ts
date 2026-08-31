// The command parser and the stateful session. Stateful on purpose: "graph
// it" is only meaningful with respect to the problem already on screen, and
// requiring the wearer to restate the equation to see its graph would defeat
// the point.

import {
  type MathExpression,
  variablesOf,
} from "./expression";
import { describeNumber, fromDecimal } from "./math-number";
import { type AdvancedTopic, answerAdvanced, parseAdvanced } from "./advanced";
import { type EvaluatorContext, radiansContext } from "./evaluator";
import { parseSpoken } from "./parser";
import { MathParseError } from "./lexer";
import {
  type MathSolution,
  type SolutionStep,
  solutionHeadline,
  solve as solveExpression,
} from "./solver";
import { type Graph, type GraphViewport, functionBody, plot } from "./plotter";
import { differentiate, integrateNumeric } from "./derivative";
import { plain } from "./text-renderer";
import { type MathWorkload } from "./workload";

// ---------------------------------------------------------------------------
// Commands

/**
 * What the wearer asked for. Parsed from speech so "graph it" and "explain
 * it" work as follow-ups to a problem already on the glasses, without
 * restating it.
 */
export type MathCommand =
  /** A new problem to solve or evaluate. */
  | { kind: "problem"; text: string }
  | { kind: "graph" }
  | { kind: "explain" }
  | { kind: "nextStep" }
  | { kind: "previousStep" }
  | { kind: "derivative"; variable: string | null }
  | { kind: "integrate"; variable: string | null; from: number; to: number }
  | { kind: "restate" }
  | { kind: "clear" }
  /**
   * A named advanced topic — primality, an integral, a limit, a shape's
   * area. These carry their own arguments rather than acting on a standing
   * expression, which is why they are a separate case.
   */
  | { kind: "advanced"; topic: AdvancedTopic };

/**
 * Recognise a follow-up. Returns null when the utterance is not a math
 * command at all, so the caller can leave unrelated speech alone.
 */
export function parseCommand(utterance: string): MathCommand | null {
  const text = utterance.toLowerCase().replace(/^[ .,!?]+|[ .,!?]+$/g, "");

  // Follow-ups first: they are short and would otherwise be parsed as
  // (nonsense) expressions.
  //
  // The bare verb is listed alongside every "it"/"that"/"this" form on
  // purpose: these are the three commands a wearer is TOLD they can say, and
  // someone who has been shown "Graph" will say "graph" as often as
  // "graph it". Leaving the bare form out makes the feature look broken in
  // exactly the case the user was taught.
  switch (text) {
    case "graph":
    case "graph it":
    case "graph that":
    case "graph this":
    case "plot":
    case "plot it":
    case "plot that":
    case "plot this":
    case "show the graph":
    case "draw it":
    case "show me the graph":
      return { kind: "graph" };
    case "explain":
    case "explain it":
    case "explain that":
    case "explain this":
    case "show the steps":
    case "show your work":
    case "how did you get that":
    case "walk me through it":
    case "step by step":
      return { kind: "explain" };
    // "Solve it" on a problem already on the lens is a request for the answer
    // again, not a re-parse — `restate` is exactly that, and routing it here
    // means the standing problem is never silently re-solved with a fresh
    // (and possibly worse) reading of the same words.
    case "solve":
    case "solve it":
    case "solve that":
    case "solve this":
    case "work it out":
    case "what is the answer":
    case "what's the answer":
    case "whats the answer":
    case "answer it":
      return { kind: "restate" };
    case "next":
    case "next step":
    case "continue":
    case "go on":
    case "and then":
      return { kind: "nextStep" };
    case "back":
    case "previous":
    case "previous step":
    case "go back":
    case "last step":
      return { kind: "previousStep" };
    case "say it again":
    case "repeat that":
    case "what was it":
    case "restate":
    case "again":
      return { kind: "restate" };
    case "clear":
    case "reset":
    case "start over":
    case "never mind":
    case "forget it":
      return { kind: "clear" };
    default:
      break;
  }

  const derivative = matchDerivative(text);
  if (derivative !== null) return { kind: "derivative", variable: derivative };
  // Advanced topics BEFORE the plain-integral shortcut and the
  // looks-like-maths gate: "the integral of x squared from 0 to 3" and "is 91
  // prime" both contain digits and operator words, and the expression parser
  // would make nonsense of either.
  const topic = parseAdvanced(utterance);
  if (topic) return { kind: "advanced", topic };
  const integral = matchIntegral(text);
  if (integral) return integral;

  // Anything with a digit, an operator word, or a relation is a problem.
  if (!looksLikeMath(text)) return null;
  return { kind: "problem", text: utterance };
}

/** Distinguishes "no derivative request" (null) from "derivative of the default variable". */
function matchDerivative(text: string): string | null {
  const triggers = [
    "differentiate",
    "take the derivative",
    "the derivative",
    "derivative of",
    "d by d",
    "find the derivative",
  ];
  if (!triggers.some((trigger) => text.includes(trigger))) return null;
  // "derivative with respect to t"
  const marker = "with respect to ";
  const index = text.indexOf(marker);
  if (index >= 0) {
    const tail = text.slice(index + marker.length).trim();
    const first = tail.split(/\s+/)[0];
    if (first && first.length <= 12) return first;
  }
  return "";
}

function matchIntegral(text: string): MathCommand | null {
  if (!text.includes("integral") && !text.includes("integrate")) return null;
  // "integrate from 0 to 5"
  const match = text.match(/from\s+(-?[0-9.]+)\s+to\s+(-?[0-9.]+)/);
  if (!match) return null;
  const lower = Number(match[1]);
  const upper = Number(match[2]);
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
  return { kind: "integrate", variable: null, from: lower, to: upper };
}

/**
 * A cheap gate so ordinary conversation is not parsed as arithmetic. The
 * continuous-listening path hands this every utterance in the room; without
 * the gate, "I'll see you at four" becomes a math problem.
 */
export function looksLikeMath(text: string): boolean {
  const operatorWords = [
    "plus",
    "minus",
    "times",
    "divided",
    "equals",
    "squared",
    "cubed",
    "square root",
    "solve",
    "what is",
    "calculate",
    "percent",
    "factorial",
    "to the power",
    "log",
    "sine",
    "cosine",
    "tangent",
  ];
  const hasOperatorWord = operatorWords.some((word) => text.includes(word));
  const hasSymbol = /[+\-*/^=<>]/.test(text);
  const hasDigit = /\d/.test(text);
  // Spelled-out numbers count too. "what is two plus two" has an operator
  // word and no digit at all, and requiring a digit made the single most
  // obvious test phrase fall straight through the gate.
  const numberWords = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "hundred",
    "thousand",
    "million",
  ];
  const hasNumberWord = numberWords.some((word) => new RegExp(`\\b${word}\\b`).test(text));
  // A bare number is not a problem; a number with an operation is.
  return (hasDigit || hasSymbol || hasNumberWord) && (hasOperatorWord || hasSymbol);
}

// ---------------------------------------------------------------------------
// Result

export type MathSessionPayload =
  | { kind: "solution"; solution: MathSolution }
  | { kind: "graph"; graph: Graph }
  | { kind: "step"; step: SolutionStep; index: number; total: number }
  | { kind: "message"; message: string }
  | { kind: "failure"; message: string }
  /**
   * An advanced-topic answer, which has its own field list rather than a
   * solution's step sequence.
   */
  | { kind: "topic"; headline: string; detail: string; fields: string[] };

export type MathSessionResult = {
  payload: MathSessionPayload;
  /** One short line for the glasses. */
  headline: string;
  /** Fuller text for the answer view and for spoken readback. */
  detail: string;
  /**
   * Work this answer could not finish at the fast depth. The caller decides
   * whether to offer the wearer a longer run, or let the shallow answer
   * stand.
   */
  unresolvedWorkload: MathWorkload | null;
};

function result(
  payload: MathSessionPayload,
  headline: string,
  detail: string,
  unresolvedWorkload: MathWorkload | null = null,
): MathSessionResult {
  return { payload, headline, detail, unresolvedWorkload };
}

// ---------------------------------------------------------------------------
// Session

/** Holds one problem and everything derived from it, so follow-ups work. */
export class MathSession {
  private expression: MathExpression | null = null;
  private solution: MathSolution | null = null;
  private stepIndex = 0;
  private usesDegrees: boolean;

  constructor(usesDegrees = false) {
    this.usesDegrees = usesDegrees;
  }

  get hasProblem(): boolean {
    return this.expression !== null;
  }

  get currentSolution(): MathSolution | null {
    return this.solution;
  }

  setUsesDegrees(value: boolean): void {
    this.usesDegrees = value;
  }

  private get context(): EvaluatorContext {
    const context = radiansContext();
    context.usesDegrees = this.usesDegrees;
    return context;
  }

  // Entry point --------------------------------------------------------------

  handle(utterance: string): MathSessionResult | null {
    const command = parseCommand(utterance);
    if (!command) return null;
    return this.execute(command);
  }

  execute(command: MathCommand): MathSessionResult {
    switch (command.kind) {
      case "problem":
        return this.solve(command.text);
      case "graph":
        return this.graph();
      case "explain":
        return this.explain();
      case "nextStep":
        return this.moveStep(1);
      case "previousStep":
        return this.moveStep(-1);
      case "derivative":
        return this.differentiate(command.variable === "" ? null : command.variable);
      case "integrate":
        return this.integrate(command.variable, command.from, command.to);
      case "restate":
        return this.restate();
      case "advanced": {
        const answer = answerAdvanced(command.topic);
        return result(
          {
            kind: "topic",
            headline: answer.headline,
            detail: answer.detail,
            fields: answer.fields.map(([label, value]) => `${label}: ${value}`),
          },
          answer.headline,
          answer.detail,
          answer.unresolvedWorkload,
        );
      }
      case "clear":
        this.expression = null;
        this.solution = null;
        this.stepIndex = 0;
        return result({ kind: "message", message: "Cleared" }, "Cleared", "Ready for a new problem.");
    }
  }

  // Commands -----------------------------------------------------------------

  solve(text: string): MathSessionResult {
    let parsed: MathExpression;
    try {
      parsed = parseSpoken(text);
    } catch (error) {
      const message =
        error instanceof MathParseError ? error.message : String((error as Error)?.message ?? error);
      return result({ kind: "failure", message }, "Could not read that", message);
    }
    const solved = solveExpression(parsed, null, this.context);
    this.expression = parsed;
    this.solution = solved;
    this.stepIndex = 0;
    return result(
      { kind: "solution", solution: solved },
      solutionHeadline(solved),
      `${plain(solved.restatement)}  →  ${solutionHeadline(solved)}`,
    );
  }

  graph(viewport: GraphViewport | null = null): MathSessionResult {
    if (!this.expression) return this.noProblem();
    const plotted = plot([this.expression], {
      viewport: viewport ?? undefined,
      usesDegrees: this.usesDegrees,
    });
    const pointCount = plotted.plots.reduce(
      (total, entry) => total + entry.segments.reduce((count, segment) => count + segment.points.length, 0),
      0,
    );
    if (pointCount <= 1) {
      return result(
        { kind: "failure", message: "Nothing to plot" },
        "Nothing to plot",
        "That expression has no real values in the visible window.",
      );
    }
    const label = plotted.plots[0]?.label ?? "";
    return result(
      { kind: "graph", graph: plotted },
      `y = ${label}`,
      `x from ${format(plotted.viewport.xMin)} to ${format(plotted.viewport.xMax)}, ` +
        `y from ${format(plotted.viewport.yMin)} to ${format(plotted.viewport.yMax)}`,
    );
  }

  explain(): MathSessionResult {
    const solution = this.solution;
    if (!solution || solution.steps.length === 0) return this.noProblem();
    this.stepIndex = 0;
    return this.stepResult(0, solution);
  }

  private moveStep(delta: number): MathSessionResult {
    const solution = this.solution;
    if (!solution || solution.steps.length === 0) return this.noProblem();
    // Clamp rather than wrap: a wearer scrolling past the end should land on
    // the answer and stay there, not loop back to the start.
    this.stepIndex = Math.max(0, Math.min(solution.steps.length - 1, this.stepIndex + delta));
    return this.stepResult(this.stepIndex, solution);
  }

  private stepResult(index: number, solution: MathSolution): MathSessionResult {
    const step = solution.steps[index]!;
    return result(
      { kind: "step", step, index, total: solution.steps.length },
      `${index + 1}/${solution.steps.length}  ${step.title}`,
      `${plain(step.expression)}\n${step.detail}`,
    );
  }

  differentiate(requestedVariable: string | null): MathSessionResult {
    if (!this.expression) return this.noProblem();
    const body = functionBody(this.expression);
    const variable = requestedVariable ?? variablesOf(body)[0] ?? "x";
    const derived = differentiate(body, variable);
    const derivedSolution: MathSolution = {
      kind: { kind: "simplified", value: derived },
      variable,
      steps: [
        {
          id: 0,
          title: "Original",
          expression: body,
          detail: `Differentiate with respect to ${variable}.`,
        },
        {
          id: 1,
          title: "Derivative",
          expression: derived,
          detail: "Apply the power, product, and chain rules, then simplify.",
        },
      ],
      restatement: body,
    };
    this.expression = derived;
    this.solution = derivedSolution;
    this.stepIndex = 0;
    return result(
      { kind: "solution", solution: derivedSolution },
      `d/d${variable} = ${plain(derived)}`,
      `The derivative of ${plain(body)} with respect to ${variable} is ${plain(derived)}.`,
    );
  }

  integrate(requestedVariable: string | null, lower: number, upper: number): MathSessionResult {
    if (!this.expression) return this.noProblem();
    const body = functionBody(this.expression);
    const variable = requestedVariable ?? variablesOf(body)[0] ?? "x";
    const area = integrateNumeric(body, variable, lower, upper);
    if (area === null) {
      return result(
        { kind: "failure", message: "Could not integrate over that range" },
        "Could not integrate",
        `The function is undefined somewhere between ${format(lower)} and ${format(upper)}.`,
      );
    }
    const value = fromDecimal(area);
    return result(
      { kind: "message", message: describeNumber(value) },
      `∫ = ${describeNumber(value)}`,
      `The definite integral of ${plain(body)} d${variable} ` +
        `from ${format(lower)} to ${format(upper)} is ${describeNumber(value)}.`,
    );
  }

  restate(): MathSessionResult {
    const solution = this.solution;
    if (!solution) return this.noProblem();
    return result(
      { kind: "solution", solution },
      solutionHeadline(solution),
      `${plain(solution.restatement)} → ${solutionHeadline(solution)}`,
    );
  }

  // Helpers ------------------------------------------------------------------

  private noProblem(): MathSessionResult {
    return result(
      { kind: "failure", message: "No problem yet" },
      "No problem yet",
      "Say an equation first, then ask to graph or explain it.",
    );
  }
}

function format(value: number): string {
  return describeNumber(fromDecimal(value));
}
