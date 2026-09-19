// Samples an expression into drawable graph data: segments, viewport,
// roots, and extrema.

import { type MathExpression, subtractExpr, variablesOf } from "./expression";
import { evaluateValue } from "./evaluator";
import { simplify } from "./simplifier";
import { Polynomial } from "./polynomial";
import { numericRoots } from "./solver";
import { fromDecimal, describeNumber } from "./math-number";
import { plain } from "./text-renderer";

// ---------------------------------------------------------------------------
// Plot model

export type GraphViewport = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

export const STANDARD_VIEWPORT: GraphViewport = { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };

export function viewportContainsY(viewport: GraphViewport, y: number): boolean {
  return y >= viewport.yMin && y <= viewport.yMax;
}

export type GraphPoint = { x: number; y: number };

/**
 * One continuous run of the curve. A function with a pole produces several,
 * so the renderer can lift the pen instead of drawing a vertical line through
 * the asymptote — which is the single most recognisable "bad graphing app"
 * artefact.
 */
export type GraphSegment = { points: GraphPoint[] };

export type GraphMarkerKind = "root" | "yIntercept" | "extremum" | "intersection";

export type GraphMarker = {
  kind: GraphMarkerKind;
  point: GraphPoint;
  label: string;
};

export type GraphPlot = {
  expression: MathExpression;
  variable: string;
  segments: GraphSegment[];
  markers: GraphMarker[];
  label: string;
};

export type GraphAxis = { ticks: number[]; step: number };

export type Graph = {
  plots: GraphPlot[];
  viewport: GraphViewport;
  xAxis: GraphAxis;
  yAxis: GraphAxis;
};

// ---------------------------------------------------------------------------
// Plotter

/**
 * Sample count. Matched to the glasses viewport width times a small factor:
 * enough that a curve looks smooth after projection, few enough that plotting
 * stays imperceptible on a phone.
 */
export const DEFAULT_SAMPLE_COUNT = 1_200;

/** Values beyond this are treated as a pole rather than a steep slope. */
const POLE_THRESHOLD = 1e7;

export function plot(
  expressions: MathExpression[],
  options: {
    variable?: string;
    viewport?: GraphViewport;
    usesDegrees?: boolean;
    sampleCount?: number;
  } = {},
): Graph {
  const usesDegrees = options.usesDegrees ?? false;
  const sampleCount = options.sampleCount ?? DEFAULT_SAMPLE_COUNT;
  const variable =
    options.variable ??
    expressions.map((expression) => variablesOf(expression)[0]).find((name) => name !== undefined) ??
    "x";

  // Autoscale y from the data when the caller did not pin a viewport, but
  // keep x at the requested (or standard) window — rescaling both makes a
  // graph that never matches what the user asked to see.
  const xWindow = options.viewport ?? STANDARD_VIEWPORT;
  const plots: GraphPlot[] = [];
  const allY: number[] = [];

  for (const expression of expressions) {
    const body = functionBody(expression);
    const sampled = sample(body, variable, xWindow.xMin, xWindow.xMax, sampleCount, usesDegrees);
    for (const segment of sampled) {
      for (const point of segment.points) allY.push(point.y);
    }
    plots.push({
      expression: body,
      variable,
      segments: sampled,
      markers: markers(body, variable, xWindow.xMin, xWindow.xMax),
      label: plain(body),
    });
  }

  const viewport = options.viewport ?? autoscale(xWindow, allY);
  const clipped = plots.map((entry) => ({
    expression: entry.expression,
    variable: entry.variable,
    segments: clip(entry.segments, viewport),
    markers: entry.markers.filter((marker) => viewportContainsY(viewport, marker.point.y)),
    label: entry.label,
  }));

  return {
    plots: clipped,
    viewport,
    xAxis: axis(viewport.xMin, viewport.xMax),
    yAxis: axis(viewport.yMin, viewport.yMax),
  };
}

/**
 * `y = x^2 + 1` and `x^2 + 1` should plot the same curve, and `x^2 + y = 1`
 * should plot `y = 1 - x^2` where that is easy to see.
 */
export function functionBody(expression: MathExpression): MathExpression {
  if (expression.type !== "relation") return expression;
  if (expression.lhs.type === "variable" && expression.lhs.name === "y") return expression.rhs;
  if (expression.rhs.type === "variable" && expression.rhs.name === "y") return expression.lhs;
  // Otherwise plot the difference, whose zero set is the relation — the
  // honest generalisation, and it makes an implicit curve's roots visible on
  // the x-axis.
  return simplify(subtractExpr(expression.lhs, expression.rhs));
}

// ---------------------------------------------------------------------------
// Sampling

export function sample(
  expression: MathExpression,
  variable: string,
  xMin: number,
  xMax: number,
  count: number,
  usesDegrees: boolean,
): GraphSegment[] {
  if (count <= 1 || xMax <= xMin) return [];
  const segments: GraphSegment[] = [];
  let current: GraphPoint[] = [];
  const step = (xMax - xMin) / (count - 1);
  let previousY: number | null = null;

  for (let index = 0; index < count; index++) {
    const x = xMin + index * step;
    const y = evaluateValue(expression, { [variable]: x }, usesDegrees);
    if (y === null || !Number.isFinite(y) || Math.abs(y) >= POLE_THRESHOLD) {
      // Undefined or blown up: close the run.
      if (current.length > 1) segments.push({ points: current });
      current = [];
      previousY = null;
      continue;
    }

    // A jump this large between adjacent samples is a pole, not a slope.
    // tan(x) is the canonical case: without this the curve gets a vertical
    // line at every asymptote.
    if (previousY !== null && Math.abs(y - previousY) > (xMax - xMin) * 50) {
      if (current.length > 1) segments.push({ points: current });
      current = [];
    }
    current.push({ x, y });
    previousY = y;
  }
  if (current.length > 1) segments.push({ points: current });
  return segments;
}

// ---------------------------------------------------------------------------
// Autoscale

/**
 * Percentile-based rather than min/max: one spike near a pole would
 * otherwise compress the interesting part of the curve into a flat line.
 */
export function autoscale(xWindow: GraphViewport, yValues: number[]): GraphViewport {
  const finite = yValues.filter((y) => Number.isFinite(y) && Math.abs(y) < POLE_THRESHOLD).sort((a, b) => a - b);
  if (finite.length <= 2) {
    return { xMin: xWindow.xMin, xMax: xWindow.xMax, yMin: -10, yMax: 10 };
  }
  const lowIndex = Math.floor(finite.length * 0.02);
  const highIndex = Math.floor(finite.length * 0.98);
  let low = finite[Math.min(lowIndex, finite.length - 1)]!;
  let high = finite[Math.min(highIndex, finite.length - 1)]!;

  // Always show the x-axis when the curve comes near it — a graph that omits
  // y = 0 reads as if the function never crosses.
  if (low > 0 && low < high * 0.5) low = 0;
  if (high < 0 && high > low * 0.5) high = 0;

  if (high - low < 1e-9) {
    const centre = (high + low) / 2;
    low = centre - 1;
    high = centre + 1;
  }
  const padding = (high - low) * 0.1;
  return {
    xMin: xWindow.xMin,
    xMax: xWindow.xMax,
    yMin: low - padding,
    yMax: high + padding,
  };
}

export function clip(segments: GraphSegment[], viewport: GraphViewport): GraphSegment[] {
  const result: GraphSegment[] = [];
  for (const segment of segments) {
    let current: GraphPoint[] = [];
    for (const point of segment.points) {
      if (viewportContainsY(viewport, point.y)) {
        current.push(point);
      } else if (current.length > 0) {
        // Keep one out-of-range point so the line exits the frame rather than
        // stopping short of the edge.
        current.push(point);
        result.push({ points: current });
        current = [];
      }
    }
    if (current.length > 1) result.push({ points: current });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Axes

/**
 * "Nice" tick spacing — 1, 2, 5, 10 × 10^n — so labels are round numbers a
 * person can read at a glance on the lens.
 */
export function axis(lower: number, upper: number, targetTicks = 10): GraphAxis {
  const span = upper - lower;
  if (span <= 0 || !Number.isFinite(span)) return { ticks: [], step: 1 };
  const rough = span / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalized = rough / magnitude;
  let step: number;
  if (normalized <= 1) step = magnitude;
  else if (normalized <= 2) step = 2 * magnitude;
  else if (normalized <= 5) step = 5 * magnitude;
  else step = 10 * magnitude;

  const ticks: number[] = [];
  let value = Math.ceil(lower / step) * step;
  while (value <= upper && ticks.length < 64) {
    // Snap a near-zero tick to exactly zero so the axis line and its label
    // agree.
    ticks.push(Math.abs(value) < step * 1e-9 ? 0 : value);
    value += step;
  }
  return { ticks, step };
}

// ---------------------------------------------------------------------------
// Markers

export function markers(
  expression: MathExpression,
  variable: string,
  xMin: number,
  xMax: number,
): GraphMarker[] {
  const result: GraphMarker[] = [];

  const yIntercept = evaluateValue(expression, { [variable]: 0 });
  if (yIntercept !== null && Number.isFinite(yIntercept) && xMin <= 0 && xMax >= 0) {
    result.push({
      kind: "yIntercept",
      point: { x: 0, y: yIntercept },
      label: `(0, ${describeNumber(fromDecimal(yIntercept))})`,
    });
  }

  // Roots: exact when the curve is a polynomial, sampled otherwise.
  const polynomial = Polynomial.extract(expression, variable);
  if (polynomial) {
    for (const root of numericRoots(polynomial, [xMin, xMax], 4_000)) {
      result.push({
        kind: "root",
        point: { x: root, y: 0 },
        label: `(${describeNumber(fromDecimal(root))}, 0)`,
      });
    }
  }
  return result.slice(0, 12);
}
