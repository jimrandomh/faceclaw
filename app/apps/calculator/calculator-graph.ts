// Draws the maths engine's already-sampled graph into the app's GrayImage viewport.
// The renderer never re-evaluates the expression: segment breaks, viewport
// clipping, roots, and extrema therefore stay exactly what the plotter
// decided, and an asymptote correctly stays an open gap rather than a
// vertical line — the single most recognisable "bad graphing app" artefact.

import { GrayImage } from "../../graphics/image";
import { type Graph, type GraphPoint, viewportContainsY } from "./math/plotter";

// Brightness levels tuned for the G2's grayscale panel: the curve stays
// visually dominant over the axes, and the axes over the tick grid.
const GRID_VALUE = 38;
const AXIS_VALUE = 150;
const BORDER_VALUE = 105;
const CURVE_VALUES = [245, 200, 160];
const MARKER_VALUE = 255;

/**
 * Draw the graph into `rect` (x, y, width, height) of the image. The caller
 * owns the header and footer rows.
 */
export function drawGraph(
  image: GrayImage,
  graph: Graph,
  rect: { x: number; y: number; width: number; height: number },
): void {
  if (rect.width <= 1 || rect.height <= 1) return;
  const viewport = graph.viewport;
  const spanX = Math.max(viewport.xMax - viewport.xMin, Number.EPSILON);
  const spanY = Math.max(viewport.yMax - viewport.yMin, Number.EPSILON);

  const px = (x: number): number => rect.x + ((x - viewport.xMin) / spanX) * rect.width;
  const py = (y: number): number => rect.y + rect.height - ((y - viewport.yMin) / spanY) * rect.height;

  const clampX = (x: number): number => Math.max(rect.x, Math.min(rect.x + rect.width - 1, x));
  const clampY = (y: number): number => Math.max(rect.y, Math.min(rect.y + rect.height - 1, y));

  // Tick grid first so the curve and axes draw over it.
  for (const tick of graph.xAxis.ticks) {
    if (tick < viewport.xMin || tick > viewport.xMax) continue;
    const x = Math.round(px(tick));
    image.drawLine(x, rect.y, x, rect.y + rect.height - 1, GRID_VALUE);
  }
  for (const tick of graph.yAxis.ticks) {
    if (tick < viewport.yMin || tick > viewport.yMax) continue;
    const y = Math.round(py(tick));
    image.drawLine(rect.x, y, rect.x + rect.width - 1, y, GRID_VALUE);
  }

  // Axes.
  if (viewport.yMin <= 0 && viewport.yMax >= 0) {
    const y = Math.round(py(0));
    image.drawLine(rect.x, y, rect.x + rect.width - 1, y, AXIS_VALUE);
  }
  if (viewport.xMin <= 0 && viewport.xMax >= 0) {
    const x = Math.round(px(0));
    image.drawLine(x, rect.y, x, rect.y + rect.height - 1, AXIS_VALUE);
  }

  // Curves, brightest first plot.
  for (let plotIndex = 0; plotIndex < graph.plots.length; plotIndex++) {
    const plot = graph.plots[plotIndex]!;
    const value = CURVE_VALUES[plotIndex % CURVE_VALUES.length]!;
    for (const segment of plot.segments) {
      let previous: GraphPoint | null = null;
      for (const point of segment.points) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          previous = null;
          continue;
        }
        if (previous) {
          image.drawLine(
            Math.round(clampX(px(previous.x))),
            Math.round(clampY(py(previous.y))),
            Math.round(clampX(px(point.x))),
            Math.round(clampY(py(point.y))),
            value,
          );
        }
        previous = point;
      }
    }

    // Markers: roots and intercepts as small filled dots.
    for (const marker of plot.markers) {
      if (!viewportContainsY(viewport, marker.point.y)) continue;
      if (marker.point.x < viewport.xMin || marker.point.x > viewport.xMax) continue;
      const cx = Math.round(px(marker.point.x));
      const cy = Math.round(py(marker.point.y));
      image.fillRoundedRect(cx - 3, cy - 3, 6, 6, MARKER_VALUE, 3);
    }
  }

  // Frame the plot area.
  image.drawRect(rect.x, rect.y, rect.width, rect.height, BORDER_VALUE);
}
