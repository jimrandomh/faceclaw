import { GrayImage } from "../../graphics/image";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { enumSettingMenuItem, toggleSettingMenuItem } from "../../ui/dashboard-settings";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext, type PaintBelow } from "../../ui/layers";
import { drawSelectionHighlight, MenuLayer, openModalMenu, type MenuItem } from "../../ui/menu";
import { LIST_ROW_TEXT_INSET, lineStep } from "../../ui/metrics";
import { createInProcessWindow, type InProcessAppOptions, type InProcessWindow } from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { GlanceBoard } from "./board";
import {
  clearConflictingSlots,
  glanceboardEnabledSetting,
  glanceShowLinesSetting,
  glanceShowOnHeadTiltSetting,
  glanceShowOnLongPressSetting,
  glanceSlotChoiceLabel,
  glanceSlotSettings,
  glanceTapDurationSetting,
  type GlanceSlotChoice,
} from "./glanceboard-settings";
import { QUADRANT_LAYOUT, resolveGlanceRegions, slotDividers } from "./layout";
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

const INTRO =
  "Small widgets shown while the display is asleep, without waking the regular UI. " +
  "A tap or a head-tilt shows the board for a few seconds and a long-press holds it " +
  "up until released; a double-tap wakes the regular UI instead.";

/** Full-page list layout shared by the sub-screens. */
function pageMenuLayout(width: number) {
  return { x: 8, y: 8, width: width - 16, opaque: true, showBorder: false } as const;
}

/**
 * The Glanceboard app's entry page. Left half: title, a short description
 * and the menu (enable toggle, live preview, slot contents, settings). Right
 * half: a scaled preview of the board's slots with their dividers and the
 * name of the widget in each. "Select Contents" moves focus into that
 * preview, where scroll picks a quadrant and a tap opens the picker for it;
 * a double-tap returns focus to the menu.
 */
class GlanceboardHomeLayer implements Layer {
  private menu: MenuLayer | null = null;
  private menuTop = 0;
  private focus: "menu" | "preview" = "menu";
  private selectedSlot = 0;

  private currentMenu(ctx: LayerContext, menuTop: number): MenuLayer {
    if (!this.menu || this.menuTop !== menuTop) {
      const { width, height } = ctx.stack.getBaseSize();
      const half = (width / 2) | 0;
      const items: MenuItem[] = [
        toggleSettingMenuItem(glanceboardEnabledSetting),
        {
          label: "Preview",
          onSelect: (menuCtx) => menuCtx.stack.push(new GlancePreviewLayer(() => menuCtx.actions.requestRender())),
        },
        {
          label: "Select Contents",
          onSelect: () => {
            this.focus = "preview";
          },
        },
        {
          label: "Settings",
          onSelect: (menuCtx) => menuCtx.stack.push(new GlanceSettingsLayer()),
        },
      ];
      this.menuTop = menuTop;
      this.menu = new MenuLayer(null, items, {
        x: 8, y: menuTop, width: half - 16,
        showBorder: false, minHeight: 0, maxHeight: height - menuTop,
      });
    }
    return this.menu;
  }

  /** Where the scaled board sits: the right half, board aspect, vertically centred. */
  private previewRect(width: number, height: number): { x: number; y: number; width: number; height: number } {
    const half = (width / 2) | 0;
    const availableWidth = width - half - 2 * PREVIEW_MARGIN;
    const scale = Math.min(availableWidth / QUADRANT_LAYOUT.width, (height - 2 * PREVIEW_MARGIN) / QUADRANT_LAYOUT.height);
    const previewWidth = Math.round(QUADRANT_LAYOUT.width * scale);
    const previewHeight = Math.round(QUADRANT_LAYOUT.height * scale);
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
    // The menu paints onto this page below the paragraph (its fill is raster,
    // so the deferred paragraph glyphs above stay untouched either way).
    // While the preview has focus the menu keeps its outline-only selection.
    const menu = this.currentMenu(ctx, y + 4);
    const menuFocused = ctx.stack.isFocused() && this.focus === "menu";
    const menuCtx: LayerContext = { ...ctx, stack: Object.assign(Object.create(ctx.stack), { isFocused: () => menuFocused }) };
    menu.paint(menuCtx, () => image);

    const preview = this.previewRect(width, height);
    drawSlotPreview(image, preview, {
      selectedSlot: this.selectedSlot,
      selectionFocused: ctx.stack.isFocused() && this.focus === "preview",
    });
    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (this.focus === "preview") {
      const slotCount = QUADRANT_LAYOUT.slots.length;
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
    await this.currentMenu(ctx, this.menuTop).handleInput(event, ctx);
  }
}

/**
 * The board's slots scaled into `rect`: dividers (full brightness, or the
 * dimmest dotted line when "Show lines" is off), the widget name centred in
 * each region (a merged double-height region has one name and no line
 * across it), and the selected quadrant highlighted.
 */
function drawSlotPreview(
  image: GrayImage,
  rect: { x: number; y: number; width: number; height: number },
  options: { selectedSlot: number; selectionFocused: boolean },
): void {
  const font = getDefaultSmallFont();
  const layout = QUADRANT_LAYOUT;
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
  const setting = glanceSlotSettings(QUADRANT_LAYOUT)[slotIndex];
  if (!setting) return;
  const current = setting.get();
  const items: MenuItem[] = setting.values.map((value) => ({
    label: setting.displayValue(value),
    onSelect: (menuCtx) => {
      setting.set(value);
      clearConflictingSlots(QUADRANT_LAYOUT, slotIndex, value);
      menuCtx.stack.pop();
    },
    render: ({ image, x, y }) => {
      image.drawText(getDefaultSmallFont(), x, y + LIST_ROW_TEXT_INSET, `${setting.displayValue(value)}${setting.get() === value ? " *" : ""}`, 200);
    },
  }));
  openModalMenu(ctx, setting.label, items, Math.max(0, setting.values.indexOf(current)));
}

/** Settings: which sleep gestures show the board, for how long, and the slot lines. */
class GlanceSettingsLayer implements Layer {
  private menu: MenuLayer | null = null;

  private currentMenu(ctx: LayerContext): MenuLayer {
    if (!this.menu) {
      const { width } = ctx.stack.getBaseSize();
      const items: MenuItem[] = [
        enumSettingMenuItem(glanceTapDurationSetting),
        toggleSettingMenuItem(glanceShowOnLongPressSetting),
        toggleSettingMenuItem(glanceShowOnHeadTiltSetting),
        toggleSettingMenuItem(glanceShowLinesSetting),
      ];
      this.menu = new MenuLayer("Glanceboard settings", items, pageMenuLayout(width));
    }
    return this.menu;
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    return this.currentMenu(ctx).paint(ctx, paintBelow);
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    await this.currentMenu(ctx).handleInput(event, ctx);
  }
}

/** The live board in the window; any click or double-click returns to the list. */
class GlancePreviewLayer implements Layer {
  private readonly board: GlanceBoard;

  constructor(requestRender: () => void) {
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
  }
}

export function createGlanceboardAppWindow(options: InProcessAppOptions): InProcessWindow {
  return createInProcessWindow({
    appId: "glanceboard",
    windowId: GLANCEBOARD_WINDOW_ID,
    title: "Glanceboard",
    iconLetter: "Gb",
    icon: "eye",
    closeable: true,
    // 576x288: the board's own size, so the preview is pixel-exact.
    heightMode: "medium",
    actions: options.actions,
    // Not wrapped in YieldAtRootLayer: the home page routes double-click
    // itself (preview focus -> menu focus, menu focus -> sidebar).
    baseLayer: new GlanceboardHomeLayer(),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    reconfigureSurface: options.reconfigureSurface,
    onClosed: options.onClosed,
  });
}
