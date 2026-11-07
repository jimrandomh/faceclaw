/**
 * Synchronous icon rasterization: an <img> of the SVG would load asynchronously,
 * so the shapes (Lucide-style icons and store icons: paths and basic shapes with
 * at most a few presentation attributes) are drawn directly on an OffscreenCanvas.
 */
import { GrayImage } from "../graphics/image";

const ATTRIBUTE = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
const ELEMENT = /<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;

type Paint = { fill: string; stroke: string; strokeWidth: number };

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE)) result[match[1]!] = match[2]!;
  return result;
}

function number(attrs: Record<string, string>, name: string): number {
  return Number.parseFloat(attrs[name] ?? "0") || 0;
}

function shapePath(name: string, attrs: Record<string, string>): Path2D | null {
  const path = new Path2D();
  switch (name) {
    case "path":
      return new Path2D(attrs.d ?? "");
    case "circle":
      path.arc(number(attrs, "cx"), number(attrs, "cy"), number(attrs, "r"), 0, Math.PI * 2);
      return path;
    case "ellipse":
      path.ellipse(number(attrs, "cx"), number(attrs, "cy"), number(attrs, "rx"), number(attrs, "ry"), 0, 0, Math.PI * 2);
      return path;
    case "rect": {
      const rx = number(attrs, "rx") || number(attrs, "ry");
      path.roundRect(number(attrs, "x"), number(attrs, "y"), number(attrs, "width"), number(attrs, "height"), rx);
      return path;
    }
    case "line":
      path.moveTo(number(attrs, "x1"), number(attrs, "y1"));
      path.lineTo(number(attrs, "x2"), number(attrs, "y2"));
      return path;
    case "polyline":
    case "polygon": {
      const points = (attrs.points ?? "").trim().split(/[\s,]+/).map(Number);
      for (let i = 0; i + 1 < points.length; i += 2) {
        if (i === 0) path.moveTo(points[i]!, points[i + 1]!);
        else path.lineTo(points[i]!, points[i + 1]!);
      }
      if (name === "polygon") path.closePath();
      return path;
    }
    default:
      return null;
  }
}

function isNone(paint: string): boolean {
  return paint === "none" || paint === "transparent";
}

export function rasterizeSvg(svg: string, size: number, strokeWidth: number): GrayImage | null {
  try {
    const root = /<svg\b([^>]*)>/.exec(svg);
    if (!root) return null;
    const rootAttrs = attributes(root[1]!);
    const viewBox = (rootAttrs.viewBox ?? `0 0 ${rootAttrs.width ?? 24} ${rootAttrs.height ?? 24}`).trim().split(/[\s,]+/).map(Number);
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const scale = Math.min(size / (viewBox[2] || 24), size / (viewBox[3] || 24));
    ctx.scale(scale, scale);
    ctx.translate(-(viewBox[0] || 0), -(viewBox[1] || 0));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // The same defaults as the Android renderer: an explicit fill="none" means a
    // stroked (Lucide) icon, otherwise a filled glyph.
    const stack: Paint[] = [{
      fill: rootAttrs.fill ?? "#fff",
      stroke: rootAttrs.stroke ?? (rootAttrs.fill === "none" ? "#fff" : "none"),
      strokeWidth: Number.parseFloat(rootAttrs["stroke-width"] ?? "") || strokeWidth,
    }];
    const inherit = (attrs: Record<string, string>): Paint => {
      const parent = stack[stack.length - 1]!;
      return {
        fill: attrs.fill ?? parent.fill,
        stroke: attrs.stroke ?? parent.stroke,
        strokeWidth: Number.parseFloat(attrs["stroke-width"] ?? "") || parent.strokeWidth,
      };
    };
    for (const match of svg.matchAll(ELEMENT)) {
      const [, closing, name, rawAttributes, selfClosing] = match;
      if (name === "svg") continue;
      if (name === "g") {
        if (closing) { if (stack.length > 1) stack.pop(); }
        else if (!selfClosing) stack.push(inherit(attributes(rawAttributes!)));
        continue;
      }
      if (closing) continue;
      const attrs = attributes(rawAttributes!);
      const path = shapePath(name!, attrs);
      if (!path) continue;
      const paint = inherit(attrs);
      const stroked = name === "line" || name === "polyline";
      if (!isNone(paint.fill) && !(stroked && attrs.fill === undefined)) {
        ctx.fillStyle = "#fff";
        ctx.fill(path, attrs["fill-rule"] === "evenodd" ? "evenodd" : "nonzero");
      }
      if (!isNone(paint.stroke)) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = paint.strokeWidth;
        ctx.stroke(path);
      }
    }
    const rgba = ctx.getImageData(0, 0, size, size).data;
    const image = new GrayImage(size, size, 0);
    for (let i = 0; i < size * size; i++) image.pixels[i] = rgba[i * 4 + 3]!;
    return image;
  } catch (error) {
    console.warn(`Could not rasterize an icon: ${error}`);
    return null;
  }
}
