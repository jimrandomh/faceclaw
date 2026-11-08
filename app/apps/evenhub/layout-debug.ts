/**
 * Debug-log descriptions of EvenHub page layouts and container updates.
 * session.ts sends them to logcat at debug level (tag FaceclawEvenHubLayout).
 *
 * "note:" lines point out page quirks that change what stock (and so we) do
 * with it: shared ids, missing or extra capture containers, a wrong
 * containerTotalNum.
 */
import {
  paintOrder,
  readOptionalNumber,
  type EvenHubContainer,
  type EvenHubListContainer,
  type EvenHubPage,
  type EvenHubTextContainer,
} from "./containers";
import type { PreparedImage } from "./image-pipeline";

const CONTENT_PREVIEW_CHARS = 40;
const RAW_STRING_CHARS = 120;
const RAW_ARRAY_ITEMS = 32;

function label(c: EvenHubContainer): string {
  return `${c.kind}#${c.id} ${JSON.stringify(c.name)}`;
}

function preview(text: string): string {
  return JSON.stringify(text.length > CONTENT_PREVIEW_CHARS ? `${text.slice(0, CONTENT_PREVIEW_CHARS)}…` : text);
}

function decoration(c: EvenHubTextContainer | EvenHubListContainer): string {
  let out = "";
  if (c.borderWidth > 0) out += ` border=${c.borderWidth}c${c.borderColor}${c.borderRadius > 0 ? `r${c.borderRadius}` : ""}`;
  if (c.paddingLength > 0) out += ` pad=${c.paddingLength}`;
  if (c.isEventCapture) out += " capture";
  if (c.font) out += " font";
  return out;
}

function describeContainer(c: EvenHubContainer): string {
  const z = c.zOrderIndex === undefined ? "" : ` z=${c.zOrderIndex}`;
  const head = `${label(c)} @${c.x},${c.y} ${c.width}x${c.height}${z}`;
  switch (c.kind) {
    case "image":
      return `${head} ${c.pixels ? `pixels=${c.pixelsWidth}x${c.pixelsHeight}` : "no pixels yet"}`;
    case "text": {
      const color = c.textColor === undefined ? "" : ` color=${c.textColor}`;
      return `${head}${decoration(c)}${color} len=${c.content.length} ${preview(c.content)}`;
    }
    case "list":
      return `${head}${decoration(c)} items=${c.itemNames.length} itemWidth=${c.itemWidth}${c.selectBorder ? " selectBorder" : ""} selected=${c.selectedIndex}`;
  }
}

/** Quirks of a page that change how stock treats it. */
export function pageNotes(page: EvenHubPage, declaredTotal?: number): string[] {
  const notes: string[] = [];
  const ordered = paintOrder(page.containers);
  const byId = new Map<number, EvenHubContainer[]>();
  for (const c of ordered) byId.set(c.id, [...(byId.get(c.id) ?? []), c]);
  byId.forEach((shared, id) => {
    if (shared.length > 1) {
      notes.push(`id ${id} is shared by ${shared.map(label).join(", ")}; updates and events resolve to ${label(shared[0]!)} only`);
    }
  });
  const captures = ordered.filter((c) => c.kind !== "image" && c.isEventCapture);
  if (captures.length === 0) notes.push("no event-capture container, so the app gets no input");
  else if (captures.length > 1) notes.push(`${captures.length} event-capture containers; only the first, ${label(captures[0]!)}, gets input`);
  if (declaredTotal !== undefined && declaredTotal !== page.containers.length) {
    notes.push(`containerTotalNum is ${declaredTotal} but ${page.containers.length} containers were sent (nothing checks it)`);
  }
  return notes;
}

/** The payload, as compact JSON with long strings and arrays cut short. */
function rawJson(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data, (_key, value: unknown) => {
      if (typeof value === "string" && value.length > RAW_STRING_CHARS) {
        return `${value.slice(0, RAW_STRING_CHARS)}…(${value.length} chars)`;
      }
      if (Array.isArray(value) && value.length > RAW_ARRAY_ITEMS) {
        return [...value.slice(0, RAW_ARRAY_ITEMS), `…(${value.length} items)`];
      }
      return value;
    });
  } catch (error) {
    return `(unserializable: ${String(error)})`;
  }
}

/** A create/rebuild/extension layout: one line per container in paint order, then notes, then the raw payload. */
export function describePage(method: string, page: EvenHubPage, data: Record<string, unknown>): string[] {
  const containers = page.containers;
  const count = (kind: EvenHubContainer["kind"]) => containers.filter((c) => c.kind === kind).length;
  const declaredTotal = readOptionalNumber(data, "containerTotalNum");
  const total = declaredTotal === undefined ? "" : `, containerTotalNum=${declaredTotal}`;
  const menu = page.menuItems.length > 0 ? `, ${page.menuItems.length} menu items` : "";
  const lines = [
    `${method}: ${containers.length} containers (${count("list")} list, ${count("text")} text, ${count("image")} image)` +
      `${total}${menu}; painted bottom to top:`,
  ];
  paintOrder(containers).forEach((c, i) => lines.push(`  ${i}: ${describeContainer(c)}`));
  for (const note of pageNotes(page, declaredTotal)) lines.push(`  note: ${note}`);
  lines.push(`  raw: ${rawJson(data)}`);
  return lines;
}

function payloadKind(raw: unknown): string {
  if (raw === undefined || raw === null) return "missing";
  if (Array.isArray(raw)) return `number[${raw.length}]`;
  if (typeof raw === "string") return `string(${raw.length} chars)`;
  if (typeof raw === "object") return `object(${Object.keys(raw).length} keys)`;
  return typeof raw;
}

/** Lit-pixel count and bounding box of 4-bit levels, so a blank "hide this" image is recognizable. */
function litSummary(levels: Uint8Array, width: number): string {
  let lit = 0;
  let max = 0;
  let x0 = width;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]!;
    if (level === 0) continue;
    lit++;
    if (level > max) max = level;
    const x = i % width;
    const y = Math.floor(i / width);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return lit === 0 ? "blank" : `lit=${lit}px max=${max}/15 bbox=${x0},${y0}-${x1},${y1}`;
}

export type ImageUpdateDebug = {
  sentId: number;
  sentName: string;
  raw: unknown;
  /** The container the id resolves to. */
  target: EvenHubContainer | undefined;
  prepared: PreparedImage;
  /** Whether the container now shows the update. */
  shown: boolean;
  /** EhImageUpdateResult returned to the app. */
  result: number;
};

export function describeImageUpdate(u: ImageUpdateDebug): string[] {
  const parts = [`updateImageRawData id=${u.sentId} ${JSON.stringify(u.sentName)}`];
  parts.push(`-> ${u.target ? label(u.target) : "no container"}`);
  parts.push(`payload=${payloadKind(u.raw)}`);
  if (u.prepared.format) parts.push(`format=${u.prepared.format}`);
  if (u.prepared.levels) parts.push(`${u.prepared.width}x${u.prepared.height} ${litSummary(u.prepared.levels, u.prepared.width)}`);
  parts.push(`result=${u.result}`, u.shown ? "shown" : "not shown");
  const lines = [parts.join(" ")];
  if (u.prepared.reason) lines.push(`  ${u.prepared.reason}`);
  if (u.prepared.result === 0 && u.target?.kind !== "image") {
    lines.push(`  the id ${u.target ? `resolves to ${label(u.target)}` : "matches no container"}, so the glasses refuse the transfer`);
  } else if (u.prepared.result === 0 && !u.shown && u.target) {
    lines.push(`  ${u.prepared.width}x${u.prepared.height} isn't the container's ${u.target.width}x${u.target.height}, so the glasses drop it`);
  }
  return lines;
}

export function describeTextUpgrade(
  sentId: number,
  sentName: string,
  container: EvenHubTextContainer | null,
  offset: number | undefined,
  sentLength: number,
): string {
  if (!container) return `textContainerUpgrade id=${sentId} ${JSON.stringify(sentName)}: no container with that id`;
  const at = offset === undefined ? "" : ` offset=${offset}`;
  const color = container.textColor === undefined ? "" : ` color=${container.textColor}`;
  return `textContainerUpgrade ${label(container)}${at} sent=${sentLength} chars -> len=${container.content.length}${color} ${preview(container.content)}`;
}
