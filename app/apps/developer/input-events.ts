import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import type { InputEvent } from "../../ui/gestures";
import { addInputListener, InputEventLog, inputTimestamp } from "../../ui/input-monitor";
import type { Layer, LayerContext } from "../../ui/layers";
import { drawListScrollbar, type MenuItem } from "../../ui/menu";

/** Gestures are samples here; back/clear/pause live in the tap-then-hold menu. */
export class InputEventsLayer implements Layer {
  readonly acceptsDirectional = true;
  readonly log = new InputEventLog();
  private scrollRow = 0;
  private phoneTime = false;
  private visibleRows = 1;
  private readonly unsubscribe: () => void;

  constructor(requestRender: () => void, isVisible: () => boolean,
    private readonly removed: () => void = () => {}) {
    this.unsubscribe = addInputListener((event, filtered) => {
      if (!isVisible() || this.log.paused) return;
      this.log.add(event, filtered);
      this.scrollRow = 0;
      requestRender();
    });
  }

  onRemoved(): void { this.unsubscribe(); this.removed(); }

  menuItems(): MenuItem[] {
    return [
      { label: this.log.paused ? "Resume capture" : "Pause capture", onSelect: (ctx) => {
        this.log.paused = !this.log.paused;
        this.scrollRow = 0;
        ctx.stack.pop();
      } },
      { label: "Clear history", onSelect: (ctx) => {
        this.log.clear();
        this.scrollRow = 0;
        ctx.stack.pop();
      } },
      { label: this.phoneTime ? "Show ring timestamps" : "Show phone receive time", onSelect: (ctx) => {
        this.phoneTime = !this.phoneTime;
        ctx.stack.pop();
      } },
      { label: "Back to Debug tests", onSelect: (ctx) => { ctx.stack.popThrough(this); } },
    ];
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const font = getDefaultSmallFont();
    image.drawText(font, 12, 8, "Input events", 230);
    const status = `${this.log.paused ? "Paused" : "Live"}  ${this.log.count} events`;
    image.drawText(font, width - 12 - font.measureText(status), 8, status, 180);
    image.drawText(font, 12, 28, this.phoneTime ? "Phone receive time | gap ms | source | event" : "Time (R=ring tick) | gap | source | event", 140);
    const lineHeight = Math.max(18, font.lineHeight + 2);
    const rowHeight = lineHeight * 2 + 4;
    this.visibleRows = Math.max(1, Math.floor((height - 76) / rowHeight));
    this.scrollRow = Math.min(this.scrollRow, Math.max(0, this.log.entries.length - this.visibleRows));
    const timeX = 12;
    const gapX = timeX + font.measureText("00:00:00.000") + 12;
    const sourceX = gapX + font.measureText("+99999") + 12;
    const eventX = sourceX + font.measureText("right-arm") + 12;
    if (!this.log.entries.length) {
      image.drawText(font, 12, 62, "Touch, tap, double-tap, hold, or swipe the ring.", 210);
      image.drawText(font, 12, 82, "Press arrives before an interpreted gesture.", 150);
    }
    for (const [index, entry] of this.log.entries.slice(this.scrollRow, this.scrollRow + this.visibleRows).entries()) {
      const { event } = entry;
      const ringTime = !this.phoneTime && event.ringInput;
      const gapMs = ringTime ? entry.ringGapTicks : entry.gapMs;
      const y = 50 + index * rowHeight;
      const gap = gapMs === null ? "-" : `${gapMs >= 0 ? "+" : ""}${gapMs}`;
      const source = "source" in event ? event.source ?? "-" : "-";
      const label = (entry.filtered ? "*" : "") + (event.type === "unknown"
        ? event.ringInput ? `ring type ${event.ringInput.type}` : `${event.kind} ${event.eventSource}/${event.eventType}`
        : event.type);
      image.drawText(font, timeX, y, ringTime ? `R${ringTime.tick}` : inputTimestamp(event.timestampMs), 170);
      image.drawText(font, gapX, y, truncateText(font, gap, sourceX - gapX - 4), 160);
      image.drawText(font, sourceX, y, source, 180);
      image.drawText(font, eventX, y, truncateText(font, label, width - eventX - 12), event.type === "ring-press" ? 255 : 200);
      if (event.ringInput) {
        const { type, aux, speed } = event.ringInput;
        // These are the original report bytes, not physical distance/speed units.
        const details = `Raw ring: type ${type}   AUX ${aux}   speed ${speed}`;
        image.drawText(font, timeX + 12, y + lineHeight,
          truncateText(font, details, width - timeX - 36), 170);
      }
    }
    if (this.log.paused) drawListScrollbar(image, width - 5, 50, height - 78,
      this.scrollRow, this.visibleRows, this.log.entries.length);
    image.drawText(font, 12, height - 20,
      this.log.paused ? "Scroll: history   Tap-hold: controls" : "Unfiltered (*=dedup)  Tap-hold: controls", 140);
    return image;
  }

  handleInput(event: InputEvent): void {
    // Live gestures, including double-click, must remain on this page.
    if (!this.log.paused) return;
    if (event.type === "scroll-up" || event.type === "swipe-up") {
      this.scrollRow = Math.max(0, this.scrollRow - 1);
    } else if (event.type === "scroll-down" || event.type === "swipe-down") {
      this.scrollRow = Math.min(Math.max(0, this.log.entries.length - this.visibleRows), this.scrollRow + 1);
    }
  }
}
