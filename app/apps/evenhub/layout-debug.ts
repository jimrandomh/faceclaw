/**
 * Debug-log descriptions of EvenHub page layouts and container updates.
 * session.ts sends them to logcat at debug level (tag FaceclawEvenHubLayout).
 *
 * Lines starting "stock:" flag places where our emulation may draw something
 * stock would not, or the reverse. The stock rules come from the
 * evenRealities-openCFW reconstruction of firmware 2.2.6.10
 * (evenhub_ui_containers.c, evenhub_ui_page.c, common_image_container.c) and
 * the community simulator's hardware notes. Nobody has checked them against
 * captures of our own, so they are leads, not established facts. They also
 * describe the glasses firmware only: the Even phone app sits between the SDK
 * and the firmware and may validate or convert payloads first.
 */
import {
  paintOrder,
  readOptionalNumber,
  type EvenHubContainer,
  type EvenHubImageContainer,
  type EvenHubListContainer,
  type EvenHubPage,
  type EvenHubTextContainer,
} from "./containers";

/** Stock image-container size limits; outside them the container, and so the whole page, fails to create. */
const STOCK_IMAGE_MIN_SIZE = 20;
const STOCK_IMAGE_MAX_WIDTH = 288;
const STOCK_IMAGE_MAX_HEIGHT = 144;

const CONTENT_PREVIEW_CHARS = 40;
const RAW_STRING_CHARS = 120;
const RAW_ARRAY_ITEMS = 32;

/**
 * Stock's bottom-to-top container order: lists, then texts, then images (each
 * in declaration order). The firmware sorts by zOrderIndex (stably) only when
 * every container has one and there are at least two.
 */
export function stockPaintOrder(containers: readonly EvenHubContainer[]): EvenHubContainer[] {
  const legacy = [
    ...containers.filter((c) => c.kind === "list"),
    ...containers.filter((c) => c.kind === "text"),
    ...containers.filter((c) => c.kind === "image"),
  ];
  const allHaveZ = legacy.every((c) => c.zOrderIndex !== undefined);
  if (!allHaveZ || legacy.length < 2) return legacy;
  return legacy.sort((a, b) => (a.zOrderIndex ?? 0) - (b.zOrderIndex ?? 0));
}

function label(c: EvenHubContainer): string {
  return `${c.kind}#${c.id} ${JSON.stringify(c.name)}`;
}

function preview(text: string): string {
  return JSON.stringify(text.length > CONTENT_PREVIEW_CHARS ? `${text.slice(0, CONTENT_PREVIEW_CHARS)}…` : text);
}

function decoration(c: EvenHubTextContainer | EvenHubListContainer): string {
  let out = "";
  if (c.borderWidth > 0) out += ` border=${c.borderWidth}${c.borderRadius > 0 ? `r${c.borderRadius}` : ""}`;
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

function overlaps(a: EvenHubContainer, b: EvenHubContainer): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Ways a page would lay out or behave differently on stock firmware. */
export function stockDifferences(page: EvenHubPage, declaredTotal?: number): string[] {
  const notes: string[] = [];
  const containers = page.containers;
  const ours = paintOrder(containers);
  const stock = stockPaintOrder(containers);

  const withZ = containers.filter((c) => c.zOrderIndex !== undefined).length;
  if (withZ > 0 && withZ < containers.length) {
    notes.push(`zOrderIndex is set on ${withZ} of ${containers.length} containers: we sort by it (missing = 0), stock ignores it`);
  }
  if (ours.some((c, i) => c !== stock[i])) {
    notes.push(`paint order differs; stock bottom to top is ${stock.map(label).join(", ")}`);
    for (let i = 0; i < ours.length; i++) {
      for (let j = i + 1; j < ours.length; j++) {
        const below = ours[i]!;
        const above = ours[j]!;
        if (overlaps(below, above) && stock.indexOf(below) > stock.indexOf(above)) {
          notes.push(`${label(below)} overlaps ${label(above)}: we draw ${label(above)} on top, stock draws ${label(below)} on top`);
        }
      }
    }
  }

  for (const c of containers) {
    if (c.kind !== "image") continue;
    if (c.width < STOCK_IMAGE_MIN_SIZE || c.height < STOCK_IMAGE_MIN_SIZE || c.width > STOCK_IMAGE_MAX_WIDTH || c.height > STOCK_IMAGE_MAX_HEIGHT) {
      notes.push(
        `${label(c)} is ${c.width}x${c.height}; stock fails the whole page for an image container outside ` +
          `${STOCK_IMAGE_MIN_SIZE}-${STOCK_IMAGE_MAX_WIDTH} x ${STOCK_IMAGE_MIN_SIZE}-${STOCK_IMAGE_MAX_HEIGHT}`,
      );
    }
  }

  // The firmware finds a container by id with a first-match walk of its
  // (stock-ordered) list, for image updates and events alike.
  const byId = new Map<number, EvenHubContainer[]>();
  for (const c of stock) byId.set(c.id, [...(byId.get(c.id) ?? []), c]);
  byId.forEach((shared, id) => {
    if (shared.length > 1) {
      notes.push(`id ${id} is shared by ${shared.map(label).join(", ")}; stock resolves it to ${label(shared[0]!)} only`);
    }
  });

  const captures = stock.filter((c) => c.kind !== "image" && c.isEventCapture);
  if (captures.length !== 1) {
    notes.push(
      captures.length === 0
        ? "no event-capture container (stock requires exactly one)"
        : `${captures.length} event-capture containers; stock binds only the first, ${label(captures[0]!)}`,
    );
  }

  if (declaredTotal !== undefined && declaredTotal !== containers.length) {
    notes.push(`containerTotalNum is ${declaredTotal} but ${containers.length} containers were sent`);
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

/** A create/rebuild/extension layout: one line per container in our paint order, then stock differences, then the raw payload. */
export function describePage(method: string, page: EvenHubPage, data: Record<string, unknown>): string[] {
  const containers = page.containers;
  const count = (kind: EvenHubContainer["kind"]) => containers.filter((c) => c.kind === kind).length;
  const declaredTotal = readOptionalNumber(data, "containerTotalNum");
  const total = declaredTotal === undefined ? "" : `, containerTotalNum=${declaredTotal}`;
  const menu = page.menuItems.length > 0 ? `, ${page.menuItems.length} menu items` : "";
  const lines = [
    `${method}: ${containers.length} containers (${count("list")} list, ${count("text")} text, ${count("image")} image)` +
      `${total}${menu}; we paint bottom to top:`,
  ];
  paintOrder(containers).forEach((c, i) => lines.push(`  ${i}: ${describeContainer(c)}`));
  for (const note of stockDifferences(page, declaredTotal)) lines.push(`  stock: ${note}`);
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

function imageFormat(bytes: Uint8Array, container: EvenHubImageContainer): string {
  if (bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "PNG";
  // BITMAPINFOHEADER biBitCount: 14-byte file header + 14.
  if (bytes.length > 30 && bytes[0] === 0x42 && bytes[1] === 0x4d) return `BMP ${bytes[28]! | (bytes[29]! << 8)}bpp`;
  const area = container.width * container.height;
  if (bytes.length === area) return "raw8";
  if (bytes.length === Math.ceil(area / 2)) return "raw4";
  const head = Array.from(bytes.subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join(" ");
  return `unrecognized (${bytes.length} bytes, starts ${head})`;
}

/** Lit-pixel count and bounding box, so a blank "hide this" image is recognizable. */
function litSummary(decoded: { pixels: Uint8Array; width: number; height: number }): string {
  let lit = 0;
  let max = 0;
  let x0 = decoded.width;
  let y0 = decoded.height;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < decoded.pixels.length; i++) {
    const value = decoded.pixels[i]!;
    if (value === 0) continue;
    lit++;
    if (value > max) max = value;
    const x = i % decoded.width;
    const y = Math.floor(i / decoded.width);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return lit === 0 ? "blank" : `lit=${lit}px max=${max} bbox=${x0},${y0}-${x1},${y1}`;
}

export type ImageUpdateDebug = {
  page: EvenHubPage | null;
  sentId: number;
  sentName: string;
  container: EvenHubImageContainer | null;
  raw: unknown;
  bytes: Uint8Array | null;
  decoded: { pixels: Uint8Array; width: number; height: number } | null;
  /** BleEhSendImageResult: 0 success, 1 imageException, 2 sizeInvalid, 3 sendFailed. */
  result: number;
};

export function describeImageUpdate(u: ImageUpdateDebug): string[] {
  const parts = [`updateImageRawData ${u.container ? label(u.container) : `id=${u.sentId} ${JSON.stringify(u.sentName)}`}`];
  if (u.container && u.sentName !== "" && u.sentName !== u.container.name) parts.push(`(sent name ${JSON.stringify(u.sentName)})`);
  parts.push(`payload=${payloadKind(u.raw)}`);
  if (u.bytes && u.container) parts.push(`format=${imageFormat(u.bytes, u.container)}`);
  if (u.decoded) parts.push(`decoded=${u.decoded.width}x${u.decoded.height} ${litSummary(u.decoded)}`);
  parts.push(`result=${u.result}`);
  const lines = [parts.join(" ")];

  if (!u.container) lines.push(`  no image container with id ${u.sentId} on this page`);
  else if (u.result !== 0) lines.push("  rejected; the container keeps its previous pixels");
  if (typeof u.raw === "string") {
    lines.push("  stock: real hardware reportedly ignores a base64-string imageData (it needs bytes); we decode and draw it");
  }
  if (u.container && u.decoded && (u.decoded.width !== u.container.width || u.decoded.height !== u.container.height)) {
    lines.push(
      `  stock: the firmware only accepts a bitmap exactly the container's size (${u.container.width}x${u.container.height}); ` +
        "we tile or crop it to fit",
    );
  }
  const stockTarget = u.page ? stockPaintOrder(u.page.containers).find((c) => c.id === u.sentId) : undefined;
  if (stockTarget && stockTarget.kind !== "image") {
    lines.push(`  stock: id ${u.sentId} resolves to ${label(stockTarget)} first, so stock drops this update`);
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
  if (!container) return `textContainerUpgrade id=${sentId} ${JSON.stringify(sentName)}: no matching text container`;
  const at = offset === undefined ? "" : ` offset=${offset}`;
  const color = container.textColor === undefined ? "" : ` color=${container.textColor}`;
  return `textContainerUpgrade ${label(container)}${at} sent=${sentLength} chars -> len=${container.content.length}${color} ${preview(container.content)}`;
}
