import { GrayImage } from "../../graphics/image";
import { onAnySettingChanged } from "../../ui/dashboard-settings";
import { glanceSlotSettings, type GlanceSlotChoice } from "./glanceboard-settings";
import { QUADRANT_LAYOUT, type GlanceLayout } from "./layout";
import { type GlanceWidget } from "./widget";
import { findGlanceWidget } from "./widgets";

/** Brightness of the hairlines between slots. */
const DIVIDER_VALUE = 40;

type Slot = { choice: GlanceSlotChoice; widget: GlanceWidget | null };

/**
 * A board: the layout's slots filled with the widgets the settings choose,
 * painted as one image. Widgets are created and started when the board
 * starts and stopped when it stops; a slot setting changed meanwhile swaps
 * just that slot's widget.
 */
export class GlanceBoard {
  private slots: Slot[] = [];
  private started = false;
  private unsubscribeSettings: (() => void) | null = null;

  constructor(
    private readonly requestRender: () => void,
    readonly layout: GlanceLayout = QUADRANT_LAYOUT,
  ) {}

  get width(): number {
    return this.layout.width;
  }

  get height(): number {
    return this.layout.height;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.slots = glanceSlotSettings(this.layout).map((setting) => this.createSlot(setting.get()));
    this.unsubscribeSettings = onAnySettingChanged(() => this.applySlotSettings());
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    for (const slot of this.slots) slot.widget?.stop();
    this.slots = [];
  }

  private createSlot(choice: GlanceSlotChoice): Slot {
    const widget = choice === "none" ? null : (findGlanceWidget(choice)?.create() ?? null);
    widget?.start(this.requestRender);
    return { choice, widget };
  }

  private applySlotSettings(): void {
    if (!this.started) return;
    let changed = false;
    glanceSlotSettings(this.layout).forEach((setting, index) => {
      const choice = setting.get();
      const slot = this.slots[index];
      if (!slot || slot.choice === choice) return;
      slot.widget?.stop();
      this.slots[index] = this.createSlot(choice);
      changed = true;
    });
    if (changed) this.requestRender();
  }

  /** Paint the whole board (layout-sized). Widgets each get a fresh slot canvas. */
  paint(): GrayImage {
    const image = new GrayImage(this.layout.width, this.layout.height, 0);
    this.layout.slots.forEach((slot, index) => {
      const widget = this.slots[index]?.widget;
      if (!widget) return;
      const canvas = new GrayImage(slot.rect.width, slot.rect.height, 0);
      try {
        widget.paint(canvas);
      } catch (error) {
        console.warn(`glanceboard widget ${this.slots[index]?.choice} paint failed`, error);
      }
      canvas.composeInto(image, slot.rect.x, slot.rect.y);
    });
    drawDividers(image, this.layout);
    return image;
  }
}

/** Hairlines along every slot edge that is not the board's own edge. */
function drawDividers(image: GrayImage, layout: GlanceLayout): void {
  for (const { rect } of layout.slots) {
    if (rect.x > 0) image.drawLine(rect.x, rect.y, rect.x, rect.y + rect.height - 1, DIVIDER_VALUE);
    if (rect.y > 0) image.drawLine(rect.x, rect.y, rect.x + rect.width - 1, rect.y, DIVIDER_VALUE);
  }
}
