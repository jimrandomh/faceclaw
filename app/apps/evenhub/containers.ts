/**
 * EvenHub page-container model and lenient JSON parsing.
 *
 * Hosts and apps in the wild emit both camelCase and protobuf names
 * (Container_ID), and numbers sometimes arrive as strings, so all field
 * reads go through loose key matching (the SDK's pickLoose behavior).
 */
import { mergeFontSpecs, parseFontSpec, type EvenHubFontSpec } from "./font-spec";
import { inStockImageRange } from "./image-pipeline";

export type EvenHubTextContainer = {
  kind: "text";
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  borderWidth: number;
  /** Firmware border color index 0..16; see borderGrey. */
  borderColor: number;
  borderRadius: number;
  paddingLength: number;
  isEventCapture: boolean;
  zOrderIndex: number | undefined;
  /** Extended-layout: inherit content from a same-named container on replace. */
  preserve: boolean;
  content: string;
  /** SDK 0.0.14 textColor: brightness level 0..4; undefined means the device default (4). */
  textColor: number | undefined;
  /** Extended-layout font (merged with the layout's default); undefined is the stock font. */
  font: EvenHubFontSpec | undefined;
  /**
   * How far the text is scrolled up, in pixels. Host-local like a list's
   * selection: stock scrolls an overflowing capture container itself.
   */
  scrollY: number;
};

export type EvenHubImageContainer = {
  kind: "image";
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zOrderIndex: number | undefined;
  preserve: boolean;
  /** Decoded 8bpp grayscale, set by updateImageRawData; null until first update. */
  pixels: Uint8Array | null;
  pixelsWidth: number;
  pixelsHeight: number;
};

export type EvenHubListContainer = {
  kind: "list";
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  borderWidth: number;
  /** Firmware border color index 0..16; see borderGrey. */
  borderColor: number;
  borderRadius: number;
  paddingLength: number;
  isEventCapture: boolean;
  zOrderIndex: number | undefined;
  preserve: boolean;
  itemNames: string[];
  /** Fixed width of each item's selection outline; 0 is auto (the outline hugs the text). */
  itemWidth: number;
  /** isItemSelectBorderEn: whether the selected item is outlined. A protobuf field, so absent means off. */
  selectBorder: boolean;
  /** Selection is host-local: scroll moves it with no app round-trip. */
  selectedIndex: number;
  /** Extended-layout font (merged with the layout's default); undefined is the stock font. */
  font: EvenHubFontSpec | undefined;
};

export type EvenHubContainer = EvenHubTextContainer | EvenHubImageContainer | EvenHubListContainer;

/** One entry of the OS contextual menu an app registers via `menuObject`. */
export type EvenHubMenuItem = {
  itemName: string;
  /** Non-zero uint32, unique within the menu; echoed back in menuItemClickEvent. */
  itemID: number;
};

export type EvenHubPage = {
  /** Lists, then texts, then images, each in declaration order (stock's container list order); z-sorted at paint time. */
  containers: EvenHubContainer[];
  /**
   * The page's contextual-menu entries (SDK 0.0.14 `menuObject`). Empty when
   * the app declared none, which on rebuild is how a menu is cleared.
   */
  menuItems: EvenHubMenuItem[];
};

/** Stock draws at most a 5px border; wider requests are clamped. */
const MAX_BORDER_WIDTH = 5;

/**
 * Stock firmware limits for list and text containers (common_text_create /
 * common_list_create clamp to these), from the evenRealities-openCFW
 * reconstruction. Extended layouts are exempt: they have their own canvas.
 */
const STOCK_SCREEN_WIDTH = 576;
const STOCK_SCREEN_HEIGHT = 288;
const STOCK_MAX_BORDER_COLOR = 16;
const STOCK_MAX_BORDER_RADIUS = 10;
const STOCK_MAX_PADDING = 32;
const STOCK_MAX_LIST_ITEMS = 20;

/**
 * The border color index's grey: indices 0..15 step by 0x11 (0 is black, so a
 * border without a color is invisible) and 16 is white.
 */
export function borderGrey(index: number): number {
  return index >= 0 && index < 16 ? index * 0x11 : 0xff;
}

/** Firmware brightness levels for text; 4 is the device default. */
const MIN_TEXT_BRIGHTNESS = 0;
const MAX_TEXT_BRIGHTNESS = 4;

/** Firmware limits on a contextual menu, enforced app-side by the SDK too. */
const MENU_MAX_ITEMS = 10;
const MENU_NAME_MAX_BYTES = 32;

function normalizeKey(key: string): string {
  return key.replace(/_/g, "").toLowerCase();
}

function pickLoose(obj: Record<string, unknown>, key: string): unknown {
  if (key in obj) return obj[key];
  const wanted = normalizeKey(key);
  for (const k of Object.keys(obj)) {
    if (normalizeKey(k) === wanted) return obj[k];
  }
  return undefined;
}

export function readNumber(obj: Record<string, unknown>, key: string, fallback: number): number {
  const value = pickLoose(obj, key);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function readOptionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = readNumber(obj, key, Number.NaN);
  return Number.isNaN(value) ? undefined : value;
}

export function readString(obj: Record<string, unknown>, key: string, fallback: string): string {
  const value = pickLoose(obj, key);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

/**
 * A 0/1 protobuf flag. Stock apps send numbers; extension layouts may send
 * booleans (the extension types allow both), and numeric strings show up in
 * the wild.
 */
function readFlag(obj: Record<string, unknown>, key: string): boolean {
  const value = pickLoose(obj, key);
  if (typeof value === "boolean") return value;
  return readNumber(obj, key, 0) !== 0;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readBorderWidth(json: Record<string, unknown>): number {
  return Math.max(0, Math.min(MAX_BORDER_WIDTH, readNumber(json, "borderWidth", 0)));
}

/** A protobuf field, so an omitted borderColor is 0 (black). */
function readBorderColor(json: Record<string, unknown>): number {
  return Math.max(0, readNumber(json, "borderColor", 0));
}

/** A container's font: its own `font` over the layout-wide default. */
function readFont(json: Record<string, unknown>, layoutFont: EvenHubFontSpec | undefined): EvenHubFontSpec | undefined {
  return mergeFontSpecs(layoutFont, parseFontSpec(pickLoose(json, "font")));
}

function parseTextContainer(json: Record<string, unknown>, layoutFont: EvenHubFontSpec | undefined): EvenHubTextContainer {
  return {
    kind: "text",
    id: readNumber(json, "containerID", 0),
    name: readString(json, "containerName", ""),
    x: readNumber(json, "xPosition", 0),
    y: readNumber(json, "yPosition", 0),
    width: readNumber(json, "width", 0),
    height: readNumber(json, "height", 0),
    borderWidth: readBorderWidth(json),
    borderColor: readBorderColor(json),
    borderRadius: readNumber(json, "borderRadius", 0),
    paddingLength: readNumber(json, "paddingLength", 0),
    isEventCapture: readFlag(json, "isEventCapture"),
    zOrderIndex: readOptionalNumber(json, "zOrderIndex"),
    preserve: readFlag(json, "preserve"),
    content: readString(json, "content", ""),
    textColor: readTextBrightness(json),
    font: readFont(json, layoutFont),
    scrollY: 0,
  };
}

/**
 * A text container's brightness level, or undefined for the device default.
 * Out-of-range values are dropped rather than clamped: the SDK rejects the
 * whole call for them, so an app that sends one is already misbehaving and
 * the default level is the least surprising thing to draw.
 */
export function readTextBrightness(json: Record<string, unknown>): number | undefined {
  const value = readOptionalNumber(json, "textColor");
  if (value === undefined || !Number.isInteger(value)) return undefined;
  if (value < MIN_TEXT_BRIGHTNESS || value > MAX_TEXT_BRIGHTNESS) return undefined;
  return value;
}

/** The raw `menuObject.menuItems` array as sent, before any rule is applied. */
export function declaredMenuItems(data: Record<string, unknown>): unknown[] {
  const raw = pickLoose(asRecord(pickLoose(data, "menuObject")), "menuItems");
  return Array.isArray(raw) ? raw : [];
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Parse `menuObject.menuItems`. The SDK validates these app-side and refuses
 * to call the host at all on a violation, so anything invalid arriving here
 * came from an app bypassing the SDK; drop the offending entries (and any
 * past the tenth) rather than rejecting the whole page, which would leave the
 * app with no UI at all.
 */
export function parseMenuItems(data: Record<string, unknown>): EvenHubMenuItem[] {
  const items: EvenHubMenuItem[] = [];
  const seen = new Set<number>();
  for (const entry of declaredMenuItems(data)) {
    if (items.length >= MENU_MAX_ITEMS) break;
    const json = asRecord(entry);
    const itemID = readNumber(json, "itemID", 0);
    if (!Number.isInteger(itemID) || itemID <= 0 || itemID > 0xffffffff) continue;
    if (seen.has(itemID)) continue;
    const itemName = readString(json, "itemName", "");
    if (utf8ByteLength(itemName) > MENU_NAME_MAX_BYTES) continue;
    seen.add(itemID);
    items.push({ itemName, itemID });
  }
  return items;
}

function parseImageContainer(json: Record<string, unknown>): EvenHubImageContainer {
  return {
    kind: "image",
    id: readNumber(json, "containerID", 0),
    name: readString(json, "containerName", ""),
    x: readNumber(json, "xPosition", 0),
    y: readNumber(json, "yPosition", 0),
    width: readNumber(json, "width", 0),
    height: readNumber(json, "height", 0),
    zOrderIndex: readOptionalNumber(json, "zOrderIndex"),
    preserve: readFlag(json, "preserve"),
    pixels: null,
    pixelsWidth: 0,
    pixelsHeight: 0,
  };
}

function parseListContainer(json: Record<string, unknown>, layoutFont: EvenHubFontSpec | undefined): EvenHubListContainer {
  const itemContainer = asRecord(pickLoose(json, "itemContainer"));
  const itemNamesRaw = pickLoose(itemContainer, "itemName");
  const itemNames = Array.isArray(itemNamesRaw) ? itemNamesRaw.map(String) : [];
  return {
    kind: "list",
    id: readNumber(json, "containerID", 0),
    name: readString(json, "containerName", ""),
    x: readNumber(json, "xPosition", 0),
    y: readNumber(json, "yPosition", 0),
    width: readNumber(json, "width", 0),
    height: readNumber(json, "height", 0),
    borderWidth: readBorderWidth(json),
    borderColor: readBorderColor(json),
    borderRadius: readNumber(json, "borderRadius", 0),
    paddingLength: readNumber(json, "paddingLength", 0),
    isEventCapture: readFlag(json, "isEventCapture"),
    zOrderIndex: readOptionalNumber(json, "zOrderIndex"),
    preserve: readFlag(json, "preserve"),
    itemNames,
    itemWidth: readNumber(itemContainer, "itemWidth", 0),
    selectBorder: readFlag(itemContainer, "isItemSelectBorderEn"),
    selectedIndex: 0,
    font: readFont(json, layoutFont),
  };
}

/**
 * Parse a CreateStartUpPageContainer / RebuildPageContainer payload into a
 * page. Containers are kept in stock's container-list order: lists, then
 * texts, then images, each in declaration order (evenhub_build_container_list).
 *
 * The whole page is replaced on rebuild, which is also what gives an omitted
 * menuObject its documented meaning: the previous contextual menu goes away.
 */
export function parsePage(data: Record<string, unknown>): EvenHubPage {
  const containers: EvenHubContainer[] = [];
  // Extended layouts may set a default font for every text and list container.
  const layoutFont = parseFontSpec(pickLoose(data, "font"));
  const lists = pickLoose(data, "listObject");
  if (Array.isArray(lists)) {
    for (const item of lists) containers.push(parseListContainer(asRecord(item), layoutFont));
  }
  const texts = pickLoose(data, "textObject");
  if (Array.isArray(texts)) {
    for (const item of texts) containers.push(parseTextContainer(asRecord(item), layoutFont));
  }
  const images = pickLoose(data, "imageObject");
  if (Array.isArray(images)) {
    for (const item of images) containers.push(parseImageContainer(asRecord(item)));
  }
  return { containers, menuItems: parseMenuItems(data) };
}

/**
 * Clamp a stock page's containers the way the firmware does when it creates
 * them: positions and sizes to the 576x288 screen (images keep their size,
 * which a separate check rejects instead), border color, radius and padding to
 * their maxima, and lists to 20 items. Not for extended layouts.
 */
export function clampToStockLimits(page: EvenHubPage): void {
  for (const c of page.containers) {
    c.x = Math.min(c.x, STOCK_SCREEN_WIDTH);
    c.y = Math.min(c.y, STOCK_SCREEN_HEIGHT);
    if (c.kind === "image") continue;
    c.width = Math.min(c.width, STOCK_SCREEN_WIDTH);
    c.height = Math.min(c.height, STOCK_SCREEN_HEIGHT);
    c.borderColor = Math.min(c.borderColor, STOCK_MAX_BORDER_COLOR);
    c.borderRadius = Math.min(c.borderRadius, STOCK_MAX_BORDER_RADIUS);
    c.paddingLength = Math.min(c.paddingLength, STOCK_MAX_PADDING);
    if (c.kind === "list" && c.itemNames.length > STOCK_MAX_LIST_ITEMS) {
      c.itemNames = c.itemNames.slice(0, STOCK_MAX_LIST_ITEMS);
    }
  }
}

/** The firmware's fixed protobuf arrays: more containers than this fail to decode. */
const STOCK_MAX_LISTS = 4;
const STOCK_MAX_TEXTS = 8;
const STOCK_MAX_IMAGES = 4;

/** EhStartUpPageCreateResult values for a page the firmware can't build. */
export const PAGE_CREATE_INVALID = 1;
export const PAGE_CREATE_OUT_OF_MEMORY = 3;

/**
 * Why the stock firmware would fail to build this page, with the create result
 * the app gets, or null when it builds. Too many containers overflow the
 * firmware's protobuf arrays, so decoding fails (it replies with the code the
 * phone app maps to outOfMemory). An image container outside 20..288 x 20..144
 * fails to create (invalid container).
 */
export function stockPageFailure(page: EvenHubPage): { code: number; reason: string } | null {
  const count = (kind: EvenHubContainer["kind"]) => page.containers.filter((c) => c.kind === kind).length;
  const [lists, texts, images] = [count("list"), count("text"), count("image")];
  if (lists > STOCK_MAX_LISTS || texts > STOCK_MAX_TEXTS || images > STOCK_MAX_IMAGES) {
    return {
      code: PAGE_CREATE_OUT_OF_MEMORY,
      reason: `${lists} list, ${texts} text and ${images} image containers (at most ${STOCK_MAX_LISTS}, ${STOCK_MAX_TEXTS} and ${STOCK_MAX_IMAGES})`,
    };
  }
  for (const c of page.containers) {
    if (c.kind === "image" && !inStockImageRange(c.width, c.height)) {
      return { code: PAGE_CREATE_INVALID, reason: `image container ${JSON.stringify(c.name)} is ${c.width}x${c.height}, outside 20..288 x 20..144` };
    }
  }
  return null;
}

/**
 * Bottom-to-top paint order, as stock stacks its containers: the container
 * list order (lists, texts, images), stably sorted by zOrderIndex (larger is
 * closer to the front) only when every container has one and there are at
 * least two. So without z-order, images are drawn over text.
 */
export function paintOrder(containers: readonly EvenHubContainer[]): EvenHubContainer[] {
  const allHaveZ = containers.every((c) => c.zOrderIndex !== undefined);
  if (!allHaveZ || containers.length < 2) return [...containers];
  return [...containers].sort((a, b) => (a.zOrderIndex ?? 0) - (b.zOrderIndex ?? 0));
}

/**
 * The container that owns gesture events. Stock binds the first list or text
 * container with isEventCapture in paint order and ignores any later ones.
 */
export function eventCaptureContainer(page: EvenHubPage): EvenHubTextContainer | EvenHubListContainer | undefined {
  for (const c of paintOrder(page.containers)) {
    if (c.kind !== "image" && c.isEventCapture) return c;
  }
  return undefined;
}

/**
 * The container stock resolves an id to: the first one with that id in paint
 * order, whatever its kind, so an update aimed at a later container that
 * shares the id never reaches it.
 */
export function containerById(page: EvenHubPage | null, id: number): EvenHubContainer | undefined {
  return page ? paintOrder(page.containers).find((c) => c.id === id) : undefined;
}
