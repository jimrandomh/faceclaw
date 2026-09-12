import { GrayImage } from "../../graphics/image";
import { onAnySettingChanged } from "../../ui/dashboard-settings";
import { glanceShowLinesSetting, glanceSlotSettings } from "./glanceboard-settings";
import { QUADRANT_LAYOUT, resolveGlanceRegions, slotDividers, type GlanceLayout, type GlanceRegion } from "./layout";
import { type GlanceWidget } from "./widget";
import { findGlanceWidget, glanceWidgetSpans } from "./widgets";

/** Brightness of the hairlines between regions: the dimmest shade that survives 4bpp quantization. */
const DIVIDER_VALUE = 20;

type LiveRegion = { region: GlanceRegion; key: string; widget: GlanceWidget | null };

/** Identity of a region for diffing: which widget, in which slots. */
function regionKey(region: GlanceRegion): string {
  return `${region.choice}@${region.slots.join(",")}`;
}

/**
 * A board: the layout's slots filled with the widgets the settings choose,
 * painted as one image. A widget chosen for two vertically adjacent slots
 * (when it supports that) gets one double-height region with no divider
 * between the slots. Widgets are created and started when the board starts
 * and stopped when it stops; a settings change meanwhile restarts only the
 * regions that changed.
 */
export class GlanceBoard {
  private regions: LiveRegion[] = [];
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
    this.applySlotSettings();
    this.unsubscribeSettings = onAnySettingChanged(() => this.applySlotSettings());
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    for (const live of this.regions) live.widget?.stop();
    this.regions = [];
  }

  private currentRegions(): GlanceRegion[] {
    const choices = glanceSlotSettings(this.layout).map((setting) => setting.get());
    return resolveGlanceRegions(this.layout, choices, glanceWidgetSpans);
  }

  /** Rebuild the live regions from the settings, keeping widgets whose region is unchanged. */
  private applySlotSettings(): void {
    if (!this.started) return;
    const previous = new Map(this.regions.map((live) => [live.key, live]));
    const next: LiveRegion[] = [];
    let changed = false;
    for (const region of this.currentRegions()) {
      const key = regionKey(region);
      const kept = previous.get(key);
      if (kept) {
        previous.delete(key);
        next.push(kept);
        continue;
      }
      const widget = findGlanceWidget(region.choice)?.create() ?? null;
      widget?.start(this.requestRender);
      next.push({ region, key, widget });
      changed = true;
    }
    for (const removed of previous.values()) {
      removed.widget?.stop();
      changed = true;
    }
    this.regions = next;
    if (changed) this.requestRender();
  }

  /** Paint the whole board (layout-sized). Widgets each get a fresh canvas of their region's size. */
  paint(): GrayImage {
    const image = new GrayImage(this.layout.width, this.layout.height, 0);
    for (const live of this.regions) {
      if (!live.widget) continue;
      const { rect } = live.region;
      const canvas = new GrayImage(rect.width, rect.height, 0);
      try {
        live.widget.paint(canvas);
      } catch (error) {
        console.warn(`glanceboard widget ${live.region.choice} paint failed`, error);
      }
      canvas.composeInto(image, rect.x, rect.y);
    }
    if (glanceShowLinesSetting.get()) {
      drawDividers(image, this.layout, this.regions.map((live) => live.region));
    }
    return image;
  }
}

function drawDividers(image: GrayImage, layout: GlanceLayout, regions: readonly GlanceRegion[]): void {
  for (const line of slotDividers(layout, regions)) {
    image.drawLine(line.x0, line.y0, line.x1, line.y1, DIVIDER_VALUE);
  }
}
