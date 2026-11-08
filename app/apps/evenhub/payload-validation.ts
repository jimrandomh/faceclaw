/**
 * The checks the Even phone app applies to createStartUpPageContainer,
 * rebuildPageContainer and textContainerUpgrade payloads before it sends
 * anything to the glasses (read from its blutter decompilation:
 * EvenHubProtoJsonMapper.validateTextBrightness, mapProtoJsonKeys and
 * protobuf.dart's tag-keyed JSON parsing):
 *
 * - every key must be one the message defines (a numeric key passes as a raw
 *   protobuf tag, which we then ignore);
 * - numeric fields take an integer or a numeric string — not a boolean, a
 *   fraction or null; string fields take a string; repeated fields an array;
 * - any key named textColor, anywhere, must be an integer from 0 to 4.
 *
 * A failure means the call fails without reaching the glasses: create
 * returns invalid (1), rebuild and textContainerUpgrade return false.
 * Faceclaw's extended layouts are not checked; they carry their own keys.
 */

type FieldType = "uint" | "string" | "any" | { list: FieldType } | { message: Schema };
type Schema = Readonly<Record<string, FieldType>>;

const BOX: Schema = {
  xPosition: "uint",
  yPosition: "uint",
  width: "uint",
  height: "uint",
  containerID: "uint",
  containerName: "string",
  zOrderIndex: "uint",
};

const DECORATED: Schema = {
  ...BOX,
  borderWidth: "uint",
  borderColor: "uint",
  borderRadius: "uint",
  paddingLength: "uint",
  isEventCapture: "uint",
};

const TEXT: Schema = { ...DECORATED, content: "string", textColor: "uint" };

const ITEM_CONTAINER: Schema = {
  itemCount: "uint",
  itemWidth: "uint",
  isItemSelectBorderEn: "uint",
  itemName: { list: "string" },
};

const LIST: Schema = { ...DECORATED, itemContainer: { message: ITEM_CONTAINER } };

// The app knows position, subItems and checkedIndex (second-level menus, not
// yet in the SDK); their value types are unconfirmed, so they aren't checked.
const MENU_ITEM: Schema = { itemName: "string", itemID: "uint", position: "any", subItems: "any", checkedIndex: "any" };

const MENU: Schema = { menuItems: { list: { message: MENU_ITEM } } };

const REBUILD: Schema = {
  containerTotalNum: "uint",
  listObject: { list: { message: LIST } },
  textObject: { list: { message: TEXT } },
  imageObject: { list: { message: BOX } },
  menuObject: { message: MENU },
};

const CREATE: Schema = { ...REBUILD, widgetId: "uint" };

const TEXT_UPGRADE: Schema = {
  containerID: "uint",
  containerName: "string",
  contentOffset: "uint",
  contentLength: "uint",
  content: "string",
  textColor: "uint",
};

const SCHEMAS = { create: CREATE, rebuild: REBUILD, textUpgrade: TEXT_UPGRADE } as const;

/** What Dart's int.parse accepts. */
const INT_STRING = /^\s*[+-]?(?:\d+|0[xX][0-9a-fA-F]+)\s*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function checkValue(type: FieldType, value: unknown, path: string): string | null {
  if (type === "any") return null;
  if (value === null || value === undefined) return `${path} is null`;
  if (type === "uint") {
    if (typeof value === "number" ? Number.isInteger(value) : typeof value === "string" && INT_STRING.test(value)) return null;
    return `${path} must be an integer, not ${JSON.stringify(value)}`;
  }
  if (type === "string") return typeof value === "string" ? null : `${path} must be a string, not ${JSON.stringify(value)}`;
  if ("list" in type) {
    if (!Array.isArray(value)) return `${path} must be an array`;
    for (let i = 0; i < value.length; i++) {
      const error = checkValue(type.list, value[i], `${path}[${i}]`);
      if (error) return error;
    }
    return null;
  }
  return isRecord(value) ? checkMessage(type.message, value, path) : `${path} must be an object`;
}

function checkMessage(schema: Schema, message: Record<string, unknown>, path: string): string | null {
  for (const [key, value] of Object.entries(message)) {
    const field = schema[key];
    if (!field) {
      if (INT_STRING.test(key)) continue;
      return `unknown key ${path ? `${path}.` : ""}${key}`;
    }
    const error = checkValue(field, value, path ? `${path}.${key}` : key);
    if (error) return error;
  }
  return null;
}

/** validateTextBrightness: every textColor key, at any depth, holds an integer 0..4. */
function checkTextColors(value: unknown, path: string): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const error = checkTextColors(value[i], `${path}[${i}]`);
      if (error) return error;
    }
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if (key === "textColor" && !(typeof child === "number" && Number.isInteger(child) && child >= 0 && child <= 4)) {
        return `${at} must be an integer from 0 to 4, not ${JSON.stringify(child)}`;
      }
      const error = checkTextColors(child, at);
      if (error) return error;
    }
  }
  return null;
}

/** Why the Even app would refuse this payload without sending it, or null if it would send it. */
export function stockPayloadError(kind: keyof typeof SCHEMAS, data: Record<string, unknown>): string | null {
  return checkTextColors(data, "") ?? checkMessage(SCHEMAS[kind], data, "");
}
