import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { enumSettingMenuItem, onAnySettingChanged, toggleSettingMenuItem } from "../../ui/dashboard-settings";
import { uiFontOverridePickerMenuItem } from "../../ui/font-picker";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { drawSelectionHighlight, isMenuItemDisabled, MenuLayer, openModalMenu, submenuItem, type MenuItem } from "../../ui/menu";
import { Menu } from "../../ui/menu-core";
import { LIST_ROW_TEXT_INSET, lineStep, listRowHeight } from "../../ui/metrics";
import { createInProcessWindow, type InProcessAppOptions, type InProcessWindow } from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import type { Viewport } from "../../ui/viewport";
import { GlanceBoard } from "./board";
import { glanceFont } from "./glance-font";
import {
  clearConflictingSlots,
  glanceboardEnabledSetting,
  glanceDepthSetting,
  glanceLayout,
  glanceLayoutSetting,
  glanceShowLinesSetting,
  glanceShowOnHeadTiltSetting,
  glanceShowOnLongPressSetting,
  glanceSlotChoiceLabel,
  glanceSlotSettings,
  glanceTapDurationSetting,
  type GlanceSlotChoice,
} from "./glanceboard-settings";
import { resolveGlanceRegions, slotDividers } from "./layout";
import { type GlanceWidgetDefinition } from "./widget";
import { findGlanceWidget, glanceWidgetSpans } from "./widgets";

export const GLANCEBOARD_WINDOW_ID = "glanceboard";
export const GLANCEBOARD_SURFACE_ID = "window:glanceboard";

/** The entry page's title: its drop below the top padding. It lines up with the menu rows' text. */
const TITLE_OFFSET_Y = 2;
/** Indent of the intro paragraph under the title, and how far short of the middle it wraps. */
const PARAGRAPH_INDENT = 6;
const PARAGRAPH_RIGHT_GAP = 12;
/** The entry page splits at the middle: menu left, slot preview right, this far from the split. */
const PREVIEW_MARGIN = 8;
/** The preview's outline, drawn just outside the scaled board. */
const PREVIEW_OUTLINE = 1;
const PREVIEW_MIN_LINE_VALUE = 20;
const PREVIEW_LINE_VALUE = 100;
/** The entry menu's row boxes: gap below the paragraph, and how far short of the middle they end. */
const HOME_MENU_TOP_GAP = 12;
const HOME_MENU_RIGHT_GAP = 20;
/** Horizontal inset of row text (and custom row content) from its selection box. */
const HOME_ROW_TEXT_X = 10;
// A throwaway menu to satisfy MenuItem.onSelect's second parameter; the
// entry page's items never use it (they act via ctx only).
const NO_MENU = new MenuLayer(null, []);

const INTRO =
  "Your Glanceboard is a display for things you want to look at quickly. Starting " +
  "from the screen being off, you can show the glanceboard with a tap or " +
  "long-press-and-hold. It will close automatically.";

/** Full-page list layout shared by the sub-screens. */
const PAGE_MENU_LAYOUT = { page: true } as const;

/**
 * The Glanceboard app's entry page. Left half: title, a short description
 * and the menu (enable toggle, live preview, slot contents, settings). Right
 * half: a scaled preview of the board's slots with their dividers and the
 * name of the widget in each. "Select Contents" moves focus into that
 * preview, where scroll picks a slot and a tap opens the picker for it;
 * a double-tap returns focus to the menu.
 *
 * The menu's row boxes and the preview's outline sit at the padding
 * suggested for the window's edges (viewport.ts). The menu scrolls, so it
 * runs to the bottom edge itself, with that edge's padding after its last row.
 */
class GlanceboardHomeLayer implements Layer {
  private readonly menu: Menu<MenuItem>;
  private focus: "menu" | "preview" = "menu";
  private selectedSlot = 0;
  /** The context of the paint in progress, handed to item render callbacks. */
  private paintCtx: LayerContext | null = null;

  constructor(private readonly setPreviewVisible: (visible: boolean) => void) {
    this.menu = new Menu<MenuItem>({
      items: [
        toggleSettingMenuItem(glanceboardEnabledSetting),
        {
          label: "Preview",
          onSelect: (ctx) => {
            ctx.stack.push(new GlancePreviewLayer(
              () => ctx.actions.requestRender(),
              () => this.setPreviewVisible(false),
            ));
            this.setPreviewVisible(true);
          },
        },
        {
          label: "Select Contents",
          onSelect: () => {
            this.focus = "preview";
          },
        },
        {
          label: "Settings",
          onSelect: openGlanceSettings,
        },
      ],
      wrap: true,
      rowGap: 1,
      getHeight: () => listRowHeight(getDefaultSmallFont()),
      draw: ({ image, item, x, y, width, height, selected }) => {
        const disabled = isMenuItemDisabled(item);
        if (item.render) {
          item.render({
            image,
            x: x + HOME_ROW_TEXT_X,
            y,
            width: width - 2 * HOME_ROW_TEXT_X,
            height: height - 2,
            selected,
            disabled,
            text: item.label,
            ctx: this.paintCtx!,
          });
        } else {
          image.drawText(getDefaultSmallFont(), x + HOME_ROW_TEXT_X, y + LIST_ROW_TEXT_INSET, item.label,
            disabled ? 70 : selected ? 255 : 200);
        }
      },
    });
  }

  /**
   * Where the scaled board sits: board aspect, centred in the right half's
   * room inside the window's padding, which its outline may reach.
   */
  private previewRect(viewport: Viewport): { x: number; y: number; width: number; height: number } {
    const { width, height, padding } = viewport;
    const left = ((width / 2) | 0) + PREVIEW_MARGIN;
    const top = padding.top + PREVIEW_OUTLINE;
    const availableWidth = Math.max(0, width - padding.right - PREVIEW_OUTLINE - left);
    const availableHeight = Math.max(0, height - padding.bottom - PREVIEW_OUTLINE - top);
    const layout = glanceLayout();
    const scale = Math.min(availableWidth / layout.width, availableHeight / layout.height);
    const previewWidth = Math.round(layout.width * scale);
    const previewHeight = Math.round(layout.height * scale);
    return {
      x: left + (((availableWidth - previewWidth) / 2) | 0),
      y: top + (((availableHeight - previewHeight) / 2) | 0),
      width: previewWidth,
      height: previewHeight,
    };
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const viewport = ctx.stack.getBaseSize();
    const { width, height, padding } = viewport;
    const image = new GrayImage(width, height, 0);
    const half = (width / 2) | 0;
    const menuX = padding.left;
    const titleX = menuX + HOME_ROW_TEXT_X;
    const titleY = padding.top + TITLE_OFFSET_Y;
    image.drawText(font, titleX, titleY, "Glanceboard", 220);
    const step = lineStep(font);
    const paragraphX = titleX + PARAGRAPH_INDENT;
    let y = titleY + step + 6;
    for (const line of wrapText(font, INTRO, half - PARAGRAPH_RIGHT_GAP - paragraphX)) {
      image.drawText(font, paragraphX, y, line, 160);
      y += step;
    }
    // The menu sits below the paragraph in the left half. While the preview
    // has focus the menu keeps its outline-only selection.
    const menuTop = y + HOME_MENU_TOP_GAP;
    const menuWidth = Math.max(0, half - HOME_MENU_RIGHT_GAP - menuX);
    const menuHeight = Math.max(0, height - menuTop);
    this.paintCtx = ctx;
    try {
      this.menu.paint(image, { x: menuX, y: menuTop, width: menuWidth, height: menuHeight, padBottom: padding.bottom },
        ctx.stack.isFocused() && this.focus === "menu");
    } finally {
      this.paintCtx = null;
    }
    this.menu.drawScrollbar(image, menuX + menuWidth + 5, menuTop, Math.max(0, menuHeight - padding.bottom - 4));

    this.selectedSlot = Math.min(this.selectedSlot, glanceLayout().slots.length - 1);
    const preview = this.previewRect(viewport);
    drawSlotPreview(image, preview, {
      selectedSlot: this.selectedSlot,
      selectionFocused: ctx.stack.isFocused() && this.focus === "preview",
    });
    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (this.focus === "preview") {
      const slotCount = glanceLayout().slots.length;
      this.selectedSlot = Math.min(this.selectedSlot, slotCount - 1);
      switch (event.type) {
        case "scroll-up":
          this.selectedSlot = (this.selectedSlot + slotCount - 1) % slotCount;
          return;
        case "scroll-down":
          this.selectedSlot = (this.selectedSlot + 1) % slotCount;
          return;
        case "click":
          openSlotPicker(ctx, this.selectedSlot);
          return;
        case "double-click":
          // Back from the preview is back to the menu, not out of the app;
          // this layer is the window's root and handles the yield itself
          // (see createGlanceboardAppWindow), so the gesture arrives here.
          this.focus = "menu";
          return;
        default:
          return;
      }
    }
    if (event.type === "double-click") {
      shell.yieldFocusToSidebar();
      return;
    }
    if (event.type === "click") {
      const item = this.menu.selectedItem;
      if (item && !isMenuItemDisabled(item)) await item.onSelect(ctx, NO_MENU);
      return;
    }
    await this.menu.handleInput(event);
  }
}

/**
 * The board's slots scaled into `rect`: dividers (full brightness, or the
 * dimmest dotted line when "Show lines" is off), the widget name centred in
 * each region (a merged double-height region has one name and no line
 * across it), and the selected slot highlighted.
 */
function drawSlotPreview(
  image: GrayImage,
  rect: { x: number; y: number; width: number; height: number },
  options: { selectedSlot: number; selectionFocused: boolean },
): void {
  const font = getDefaultSmallFont();
  const layout = glanceLayout();
  const settings = glanceSlotSettings(layout);
  const choices = settings.map((setting) => setting.get());
  const regions = resolveGlanceRegions(layout, choices, glanceWidgetSpans);
  const sx = rect.width / layout.width;
  const sy = rect.height / layout.height;
  const scaled = (r: { x: number; y: number; width: number; height: number }) => ({
    x: rect.x + Math.round(r.x * sx),
    y: rect.y + Math.round(r.y * sy),
    width: Math.round(r.width * sx),
    height: Math.round(r.height * sy),
  });

  image.drawRect(rect.x - PREVIEW_OUTLINE, rect.y - PREVIEW_OUTLINE, rect.width + 2 * PREVIEW_OUTLINE, rect.height + 2 * PREVIEW_OUTLINE, 72);
  const selected = scaled(layout.slots[options.selectedSlot]!.rect);
  drawSelectionHighlight(image, selected.x + 1, selected.y + 1, selected.width - 2, selected.height - 2, options.selectionFocused, 4);

  const showLines = glanceShowLinesSetting.get();
  for (const line of slotDividers(layout, regions)) {
    const x0 = rect.x + Math.round(line.x0 * sx);
    const y0 = rect.y + Math.round(line.y0 * sy);
    const x1 = rect.x + Math.round(line.x1 * sx);
    const y1 = rect.y + Math.round(line.y1 * sy);
    if (showLines) {
      image.drawLine(x0, y0, x1, y1, PREVIEW_LINE_VALUE);
    } else {
      // Every other pixel at the dimmest visible shade: the line is there to
      // read the layout by, but says "off".
      drawDottedLine(image, x0, y0, x1, y1, PREVIEW_MIN_LINE_VALUE);
    }
  }

  // Names: one per region, "Empty" in slots no region covers.
  const covered = new Set<number>();
  const label = (r: { x: number; y: number; width: number; height: number }, text: string, value: number) => {
    const clipped = truncateText(font, text, Math.max(0, r.width - 8));
    image.drawText(font, r.x + (((r.width - font.measureText(clipped)) / 2) | 0), r.y + (((r.height - font.lineHeight) / 2) | 0), clipped, value);
  };
  for (const region of regions) {
    for (const index of region.slots) covered.add(index);
    label(scaled(region.rect), glanceSlotChoiceLabel(region.choice as GlanceSlotChoice), 210);
  }
  layout.slots.forEach((slot, index) => {
    if (!covered.has(index)) label(scaled(slot.rect), "Empty", 90);
  });
}

/** A horizontal or vertical line lit on every other pixel. */
function drawDottedLine(image: GrayImage, x0: number, y0: number, x1: number, y1: number, value: number): void {
  if (y0 === y1) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 2) image.setPixel(x, y0, value);
  } else {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 2) image.setPixel(x0, y, value);
  }
}

/** The picker for one slot: every widget, the current one marked; choosing applies the one-per-board rule. */
function openSlotPicker(ctx: LayerContext, slotIndex: number): void {
  const layout = glanceLayout();
  const setting = glanceSlotSettings(layout)[slotIndex];
  if (!setting) return;
  const current = setting.get();
  const items: MenuItem[] = setting.values.map((value) => ({
    label: setting.displayValue(value),
    onSelect: (menuCtx) => {
      setting.set(value);
      clearConflictingSlots(layout, slotIndex, value);
      menuCtx.stack.pop();
    },
    render: ({ image, x, y }) => {
      image.drawText(getDefaultSmallFont(), x, y + LIST_ROW_TEXT_INSET, `${setting.displayValue(value)}${setting.get() === value ? " *" : ""}`, 200);
    },
  }));
  openModalMenu(ctx, setting.label, items, Math.max(0, setting.values.indexOf(current)));
}

/**
 * Settings: layout, sleep gestures, duration, slot lines, widget font, and
 * stereo depth, then a row per widget on the board for its own settings.
 */
function openGlanceSettings(ctx: LayerContext): void {
  const items = (): MenuItem[] => [
    // The layout decides which slots (and so which widgets) are on the board.
    enumSettingMenuItem(glanceLayoutSetting, { onChange: () => layer.setItems(items()) }),
    enumSettingMenuItem(glanceTapDurationSetting),
    toggleSettingMenuItem(glanceShowOnLongPressSetting),
    toggleSettingMenuItem(glanceShowOnHeadTiltSetting),
    toggleSettingMenuItem(glanceShowLinesSetting),
    uiFontOverridePickerMenuItem(glanceFont, {
      title: "Glanceboard font",
      description:
        "Typeface for the Glanceboard's widgets. Same as UI font follows the Font setting in Settings > Customization.",
    }),
    enumSettingMenuItem(glanceDepthSetting),
    ...widgetSettingsMenuItems(),
  ];
  const layer = new MenuLayer("Glanceboard settings", items(), PAGE_MENU_LAYOUT);
  ctx.stack.push(layer);
}

/**
 * One row per widget on the board, in slot order: a submenu of the widget's
 * settings, or a disabled row for a widget that has none.
 */
function widgetSettingsMenuItems(): MenuItem[] {
  const widgets = new Set<GlanceWidgetDefinition>();
  for (const setting of glanceSlotSettings()) {
    const widget = findGlanceWidget(setting.get());
    if (widget) widgets.add(widget);
  }
  return Array.from(widgets, (widget): MenuItem => {
    const settingsMenuItems = widget.settingsMenuItems;
    if (!settingsMenuItems) {
      return { label: widget.label, description: `${widget.label} has no settings.`, disabled: true, onSelect: () => {} };
    }
    return submenuItem(widget.label, (ctx) => {
      ctx.stack.push(new MenuLayer(`${widget.label} settings`, settingsMenuItems(), PAGE_MENU_LAYOUT));
    }, { description: `Settings for the ${widget.label} widget.` });
  });
}

/** The live board in the window; any click or double-click returns to the list. */
class GlancePreviewLayer implements Layer {
  private readonly board: GlanceBoard;

  constructor(requestRender: () => void, private readonly onClose: () => void) {
    this.board = new GlanceBoard(requestRender);
    this.board.start();
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const board = this.board.paint();
    if (board.width === width && board.height === height) return board;
    // A viewport of another size (a per-app display override) shows the board
    // top-left, cropped or padded, rather than scaled.
    const image = new GrayImage(width, height, 0);
    board.composeInto(image, 0, 0);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "click" || event.type === "double-click") ctx.stack.pop();
  }

  onRemoved(): void {
    this.board.stop();
    this.onClose();
  }
}

export function createGlanceboardAppWindow(options: InProcessAppOptions): InProcessWindow {
  let previewVisible = false;
  const heightMode = () => previewVisible && glanceLayoutSetting.get() === "2x3" ? "max" as const : "medium" as const;
  const app = createInProcessWindow({
    appId: "glanceboard",
    windowId: GLANCEBOARD_WINDOW_ID,
    title: "Glanceboard",
    iconLetter: "Gb",
    icon: "eye",
    closeable: true,
    // Settings and the contents picker stay in the default 576x288 viewport;
    // only the live six-slot preview needs the taller window.
    heightMode: heightMode(),
    actions: options.actions,
    // Not wrapped in YieldAtRootLayer: the home page routes double-click
    // itself (preview focus -> menu focus, menu focus -> sidebar).
    baseLayer: new GlanceboardHomeLayer((visible) => {
      previewVisible = visible;
      app.setHeightMode(heightMode());
    }),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    reconfigureSurface: options.reconfigureSurface,
    onClosed: () => {
      unsubscribeSettings();
      options.onClosed();
    },
  });
  const unsubscribeSettings = onAnySettingChanged(() => app.setHeightMode(heightMode()));
  return app;
}
