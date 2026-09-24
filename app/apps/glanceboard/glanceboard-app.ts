import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { enumSettingMenuItem, onAnySettingChanged, toggleSettingMenuItem } from "../../ui/dashboard-settings";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { drawSelectionHighlight, isMenuItemDisabled, MenuLayer, openModalMenu, type MenuItem } from "../../ui/menu";
import { Menu } from "../../ui/menu-core";
import { LIST_ROW_TEXT_INSET, lineStep, listRowHeight } from "../../ui/metrics";
import { createInProcessWindow, type InProcessAppOptions, type InProcessWindow } from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { GlanceBoard } from "./board";
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
import { glanceWidgetSpans } from "./widgets";

export const GLANCEBOARD_WINDOW_ID = "glanceboard";
export const GLANCEBOARD_SURFACE_ID = "window:glanceboard";

const TITLE_X = 18;
const TITLE_Y = 10;
const PARAGRAPH_X = 24;
/** The entry page splits at the middle: menu left, slot preview right. */
const PREVIEW_MARGIN = 8;
const PREVIEW_MIN_LINE_VALUE = 20;
const PREVIEW_LINE_VALUE = 100;
/** The entry menu's row boxes: left inset, gap below the paragraph, and inset from the page's bottom. */
const HOME_MENU_X = 20;
const HOME_MENU_TOP_GAP = 12;
const HOME_MENU_BOTTOM_MARGIN = 8;
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
function pageMenuLayout(width: number) {
  return { x: 8, y: 8, width: width - 16, opaque: true, showBorder: false } as const;
}

/**
 * The Glanceboard app's entry page. Left half: title, a short description
 * and the menu (enable toggle, live preview, slot contents, settings). Right
 * half: a scaled preview of the board's slots with their dividers and the
 * name of the widget in each. "Select Contents" moves focus into that
 * preview, where scroll picks a slot and a tap opens the picker for it;
 * a double-tap returns focus to the menu.
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

  /** Where the scaled board sits: the right half, board aspect, vertically centred. */
  private previewRect(width: number, height: number): { x: number; y: number; width: number; height: number } {
    const half = (width / 2) | 0;
    const availableWidth = width - half - 2 * PREVIEW_MARGIN;
    const layout = glanceLayout();
    const scale = Math.min(availableWidth / layout.width, (height - 2 * PREVIEW_MARGIN) / layout.height);
    const previewWidth = Math.round(layout.width * scale);
    const previewHeight = Math.round(layout.height * scale);
    return {
      x: half + PREVIEW_MARGIN + (((availableWidth - previewWidth) / 2) | 0),
      y: ((height - previewHeight) / 2) | 0,
      width: previewWidth,
      height: previewHeight,
    };
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const half = (width / 2) | 0;
    image.drawText(font, TITLE_X, TITLE_Y, "Glanceboard", 220);
    const step = lineStep(font);
    let y = TITLE_Y + step + 6;
    for (const line of wrapText(font, INTRO, half - PARAGRAPH_X - 12)) {
      image.drawText(font, PARAGRAPH_X, y, line, 160);
      y += step;
    }
    // The menu sits below the paragraph in the left half. While the preview
    // has focus the menu keeps its outline-only selection.
    const menuTop = y + HOME_MENU_TOP_GAP;
    const menuWidth = half - 2 * HOME_MENU_X;
    const menuHeight = Math.max(0, height - menuTop - HOME_MENU_BOTTOM_MARGIN);
    this.paintCtx = ctx;
    try {
      this.menu.paint(image, { x: HOME_MENU_X, y: menuTop, width: menuWidth, height: menuHeight },
        ctx.stack.isFocused() && this.focus === "menu");
    } finally {
      this.paintCtx = null;
    }
    this.menu.drawScrollbar(image, HOME_MENU_X + menuWidth + 5, menuTop, menuHeight - 4);

    this.selectedSlot = Math.min(this.selectedSlot, glanceLayout().slots.length - 1);
    const preview = this.previewRect(width, height);
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

  image.drawRect(rect.x - 1, rect.y - 1, rect.width + 2, rect.height + 2, 72);
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

/** Settings: layout, sleep gestures, duration, slot lines, and stereo depth. */
function openGlanceSettings(ctx: LayerContext): void {
  const items: MenuItem[] = [
    enumSettingMenuItem(glanceLayoutSetting),
    enumSettingMenuItem(glanceTapDurationSetting),
    toggleSettingMenuItem(glanceShowOnLongPressSetting),
    toggleSettingMenuItem(glanceShowOnHeadTiltSetting),
    toggleSettingMenuItem(glanceShowLinesSetting),
    enumSettingMenuItem(glanceDepthSetting),
  ];
  ctx.stack.push(new MenuLayer("Glanceboard settings", items, pageMenuLayout(ctx.stack.getBaseSize().width)));
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
  let unsubscribeSettings: (() => void) | undefined;
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
      unsubscribeSettings?.();
      options.onClosed();
    },
  });
  unsubscribeSettings = onAnySettingChanged(() => app.setHeightMode(heightMode()));
  return app;
}
