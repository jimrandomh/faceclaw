/**
 * EvenHub page-container model and lenient JSON parsing.
 *
 * Hosts and apps in the wild emit both camelCase and protobuf names
 * (Container_ID), and numbers sometimes arrive as strings, so all field
 * reads go through loose key matching (the SDK's pickLoose behavior).
 */

export type EvenHubTextContainer = {
  kind: "text";
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  borderWidth: number;
  borderRadius: number;
  paddingLength: number;
  isEventCapture: boolean;
  zOrderIndex: number | undefined;
  /** Extended-layout: inherit content from a same-named container on replace. */
  preserve: boolean;
  content: string;
  /** SDK 0.0.14 textColor: brightness level 0..4; undefined means the device default (4). */
  textColor: number | undefined;
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
  borderRadius: number;
  paddingLength: number;
  isEventCapture: boolean;
  zOrderIndex: number | undefined;
  preserve: boolean;
  itemNames: string[];
  itemWidth: number;
  selectBorder: boolean;
  /** Selection is host-local: scroll moves it with no app round-trip. */
  selectedIndex: number;
};

export type EvenHubContainer = EvenHubTextContainer | EvenHubImageContainer | EvenHubListContainer;

/** One entry of the OS contextual menu an app registers via `menuObject`. */
export type EvenHubMenuItem = {
  itemName: string;
  /** Non-zero uint32, unique within the menu; echoed back in menuItemClickEvent. */
  itemID: number;
};

export type EvenHubPage = {
  /** In declaration order (lists, images, texts); z-sorted at paint time. */
  containers: EvenHubContainer[];
  /**
   * The page's contextual-menu entries (SDK 0.0.14 `menuObject`). Empty when
   * the app declared none, which on rebuild is how a menu is cleared.
   */
  menuItems: EvenHubMenuItem[];
};

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

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseTextContainer(json: Record<string, unknown>): EvenHubTextContainer {
  return {
    kind: "text",
    id: readNumber(json, "containerID", 0),
    name: readString(json, "containerName", ""),
    x: readNumber(json, "xPosition", 0),
    y: readNumber(json, "yPosition", 0),
    width: readNumber(json, "width", 0),
    height: readNumber(json, "height", 0),
    borderWidth: readNumber(json, "borderWidth", 0),
    borderRadius: readNumber(json, "borderRadius", 0),
    paddingLength: readNumber(json, "paddingLength", 0),
    isEventCapture: readNumber(json, "isEventCapture", 0) !== 0,
    zOrderIndex: readOptionalNumber(json, "zOrderIndex"),
    preserve: readNumber(json, "preserve", 0) !== 0,
    content: readString(json, "content", ""),
    textColor: readTextBrightness(json),
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
    preserve: readNumber(json, "preserve", 0) !== 0,
    pixels: null,
    pixelsWidth: 0,
    pixelsHeight: 0,
  };
}

function parseListContainer(json: Record<string, unknown>): EvenHubListContainer {
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
    borderWidth: readNumber(json, "borderWidth", 0),
    borderRadius: readNumber(json, "borderRadius", 0),
    paddingLength: readNumber(json, "paddingLength", 0),
    isEventCapture: readNumber(json, "isEventCapture", 0) !== 0,
    zOrderIndex: readOptionalNumber(json, "zOrderIndex"),
    preserve: readNumber(json, "preserve", 0) !== 0,
    itemNames,
    itemWidth: readNumber(itemContainer, "itemWidth", 0),
    selectBorder: readNumber(itemContainer, "isItemSelectBorderEn", 0) !== 0,
    selectedIndex: 0,
  };
}

/**
 * Parse a CreateStartUpPageContainer / RebuildPageContainer payload into a
 * page. Containers keep declaration order within and across the three arrays
 * (lists, then images, then texts — texts last so info panels and capture
 * containers sit above image tiles when no zOrderIndex is given).
 *
 * The whole page is replaced on rebuild, which is also what gives an omitted
 * menuObject its documented meaning: the previous contextual menu goes away.
 */
export function parsePage(data: Record<string, unknown>): EvenHubPage {
  const containers: EvenHubContainer[] = [];
  const lists = pickLoose(data, "listObject");
  if (Array.isArray(lists)) {
    for (const item of lists) containers.push(parseListContainer(asRecord(item)));
  }
  const images = pickLoose(data, "imageObject");
  if (Array.isArray(images)) {
    for (const item of images) containers.push(parseImageContainer(asRecord(item)));
  }
  const texts = pickLoose(data, "textObject");
  if (Array.isArray(texts)) {
    for (const item of texts) containers.push(parseTextContainer(asRecord(item)));
  }
  return { containers, menuItems: parseMenuItems(data) };
}

/** The container that owns gesture events (exactly one per valid page). */
export function eventCaptureContainer(page: EvenHubPage): EvenHubContainer | undefined {
  return page.containers.find(
    (container) => container.kind !== "image" && container.isEventCapture,
  );
}
