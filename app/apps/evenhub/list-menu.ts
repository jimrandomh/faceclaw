/**
 * EvenHub list containers, drawn and navigated by the shared Menu<T> in the
 * stock list style: the selected item gets a rounded outline sized to its
 * text, with no fill, and every other item's text is dimmed to 2/15
 * brightness. Scrolling animates and the ends bounce, like our own menus, but the
 * selection itself moves instantly (no highlight slide), as on stock.
 *
 * Native-free (the font is passed in) so it can be unit-tested under Node.
 */
import { GrayImage } from "../../graphics/image";
import { Menu } from "../../ui/menu-core";
import type { EvenHubListContainer } from "./containers";

/** The subset of EvenHubFont a list needs. */
export type EvenHubListFont = {
  readonly lineHeight: number;
  measureLine(text: string): number;
  drawText(image: GrayImage, x: number, y: number, text: string, value?: number): void;
};

/** Space between the selection outline and the item text, horizontally and vertically. */
export const LIST_ITEM_PADDING_X = 12;
export const LIST_ITEM_PADDING_Y = 6;
const LIST_SELECT_RADIUS = 8;
const SELECTED_TEXT = 255;
/** 4-bit level 3 (3/15). */
export const DESELECTED_TEXT = 50;
const OUTLINE_FOCUSED = 255;
const OUTLINE_UNFOCUSED = 130;

export function listRowHeight(font: EvenHubListFont): number {
  return font.lineHeight + 2 * LIST_ITEM_PADDING_Y;
}

/**
 * One Menu per container object, so its scroll motion persists across paints.
 * A rebuilt page has new container objects and so starts without motion.
 */
const menus = new WeakMap<EvenHubListContainer, Menu<string>>();

const ELLIPSIS = "...";

/** `text`, or its longest prefix that fits in `maxWidth` with "..." appended. */
export function truncateToWidth(font: EvenHubListFont, text: string, maxWidth: number): string {
  if (font.measureLine(text) <= maxWidth) return text;
  const chars = Array.from(text);
  // Binary search for the longest prefix that fits with the ellipsis.
  let low = 0, high = chars.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (font.measureLine(chars.slice(0, mid).join("") + ELLIPSIS) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join("") + ELLIPSIS;
}

/** The container's menu, synced to its items and selection (the container is the source of truth). */
function listMenu(list: EvenHubListContainer, font: EvenHubListFont): Menu<string> {
  let menu = menus.get(list);
  if (!menu) {
    const rowHeight = listRowHeight(font);
    menu = new Menu<string>({
      items: list.itemNames,
      selectedIndex: list.selectedIndex,
      getHeight: () => rowHeight,
      // The draw callback shows the selection, so there is no highlight to slide.
      highlight: false,
      // No wrap and no exit callbacks: the ends bounce. The session tells the app.
      wrap: false,
      draw: ({ image, item, x, y, width, height, selected, focused }) => {
        // itemWidth 0 is auto: the outline hugs the text. A fixed itemWidth
        // sets the outline's width exactly, and text that doesn't fit inside
        // its padding is cut short with "...".
        const fixedWidth = list.itemWidth > 0 ? Math.min(list.itemWidth, width) : 0;
        const text = fixedWidth ? truncateToWidth(font, item, fixedWidth - 2 * LIST_ITEM_PADDING_X) : item;
        if (selected && list.selectBorder) {
          image.drawRoundedRect(
            x,
            y,
            fixedWidth || Math.min(font.measureLine(text) + 2 * LIST_ITEM_PADDING_X, width),
            height - 1,
            focused ? OUTLINE_FOCUSED : OUTLINE_UNFOCUSED,
            LIST_SELECT_RADIUS,
          );
        }
        font.drawText(image, x + LIST_ITEM_PADDING_X, y + LIST_ITEM_PADDING_Y, text,
          selected ? SELECTED_TEXT : DESELECTED_TEXT);
      },
    });
    menus.set(list, menu);
  }
  if (menu.items !== list.itemNames) menu.setItems(list.itemNames, list.selectedIndex);
  else if (menu.selectedIndex !== list.selectedIndex) menu.select(list.selectedIndex);
  return menu;
}

/** Paint the list's items inside its border and padding. */
export function paintListItems(
  image: GrayImage,
  list: EvenHubListContainer,
  font: EvenHubListFont,
  focused: boolean,
): void {
  const inset = list.borderWidth + list.paddingLength;
  const rowHeight = listRowHeight(font);
  // A row cut by the bottom edge is drawn clipped, as a hint that there is
  // more. A container shorter than one row still shows one whole row.
  listMenu(list, font).paint(image, {
    x: list.x + inset,
    y: list.y + inset,
    width: Math.max(1, list.width - 2 * inset),
    height: Math.max(rowHeight, list.height - 2 * inset),
  }, focused);
}

/**
 * Step the selection (swipe up = previous). Returns false when it was already
 * at that end: the selection stays put and the list bounces.
 */
export function stepListSelection(list: EvenHubListContainer, font: EvenHubListFont, delta: -1 | 1): boolean {
  const menu = listMenu(list, font);
  const before = list.selectedIndex;
  menu.moveSelection(delta);
  list.selectedIndex = menu.selectedIndex ?? 0;
  return list.selectedIndex !== before;
}
