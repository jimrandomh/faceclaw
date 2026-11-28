import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import type { HidPointerSample } from "../../g2/keyboard/hid";
import { paintPointerCursor } from "../../g2/keyboard/cursor";
import { keyboardService } from "../../g2/keyboard/service";
import { type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { shell } from "../../ui/shell/shell";
import { clamp } from "../../util/numeric-util";

// How often to reconcile holding the pointer with window visibility.
const RECONCILE_INTERVAL_MS = 400;
/** A touchpad reports a hundred times a second; the page repaints at most this often. */
const RENDER_INTERVAL_MS = 33;
/** Cursor pixels per count the touchpad reports. */
const POINTER_GAIN = 1;
/** Left-click marks kept on the page. */
const MAX_MARKS = 12;

/**
 * Mouse cursor test: moves an arrow with the touchpad or mouse of the
 * keyboard paired through the glasses (app/g2/keyboard/), and shows its
 * buttons and wheel. The main UI has no cursor; this is where one is tried
 * out.
 *
 * While the page is visible it takes the pointer, so the buttons and wheel
 * show here instead of acting as select, back and scroll. A left click
 * leaves a mark where the arrow is and a right click clears them. Leave
 * with Esc, or a double tap on the ring or a temple.
 */
export class MouseTestLayer implements Layer {
  private x = -1;
  private y = -1;
  private size = { width: 0, height: 0 };
  private buttons = 0;
  private wheel = 0;
  private marks: Array<{ x: number; y: number }> = [];
  private samples = 0;
  private rate = 0;
  private rateWindowStart = Date.now();
  private removed = false;
  private release: (() => void) | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly windowId: string,
    private readonly requestRender: () => void,
  ) {
    this.reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
    this.reconcile();
  }

  /** Hold the pointer only while the page can be seen; elsewhere its buttons go back to being keys. */
  private reconcile(): void {
    if (this.removed) return;
    const visible = shell.isWindowVisible(this.windowId);
    if (visible && !this.release) {
      this.release = keyboardService.takePointer((sample) => this.onSample(sample));
    } else if (!visible && this.release) {
      this.release();
      this.release = null;
      this.buttons = 0;
    }
    // The rate reads zero once the pointer has been still for a second.
    const now = Date.now();
    if (now - this.rateWindowStart >= 1000) {
      const rate = this.samples;
      this.samples = 0;
      this.rateWindowStart = now;
      if (rate !== this.rate) {
        this.rate = rate;
        this.scheduleRender();
      }
    }
  }

  private onSample(sample: HidPointerSample): void {
    if (this.removed) return;
    this.samples++;
    const { width, height } = this.size;
    if (width > 0 && height > 0) {
      if (this.x < 0) {
        this.x = width / 2;
        this.y = height / 2;
      }
      this.x = clamp(this.x + sample.dx * POINTER_GAIN, 0, width - 1);
      this.y = clamp(this.y + sample.dy * POINTER_GAIN, 0, height - 1);
    }
    const pressed = sample.buttons & ~this.buttons;
    this.buttons = sample.buttons;
    this.wheel += sample.wheel;
    if (pressed & 1 && this.x >= 0) {
      this.marks.push({ x: Math.round(this.x), y: Math.round(this.y) });
      if (this.marks.length > MAX_MARKS) this.marks.shift();
    }
    if (pressed & 2) this.marks = [];
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderTimer !== null || this.removed) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      if (!this.removed) this.requestRender();
    }, RENDER_INTERVAL_MS);
  }

  onRemoved(): void {
    this.removed = true;
    if (this.reconcileTimer !== null) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    if (this.renderTimer !== null) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.release?.();
    this.release = null;
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height, padding } = ctx.stack.getBaseSize();
    this.size = { width, height };
    const image = new GrayImage(width, height, 0);
    const left = padding.left;
    const right = width - padding.right;
    const top = padding.top;
    const line = font.lineHeight + 4;

    image.drawText(font, left, top, "Mouse cursor", 220);
    const snapshot = keyboardService.snapshot();
    const problem = snapshot.state !== "connected"
      ? "No keyboard is connected."
      : !snapshot.pointer ? "This keyboard has no touchpad or mouse buttons." : null;
    if (problem) {
      image.drawText(font, left, top + 2 * line, problem, 190);
      image.drawText(font, left, top + 3 * line, "Pair one under Settings > Keyboard.", 120);
      return image;
    }

    const position = this.x < 0 ? "move the pointer" : `${Math.round(this.x)}, ${Math.round(this.y)}`;
    image.drawText(font, right - font.measureText(position), top, position, 150);
    // Buttons: a box each, filled while held.
    let x = left;
    const boxY = top + line;
    for (const [index, label] of ["L", "M", "R"].entries()) {
      // HID numbers them left, right, middle; they sit left, middle, right.
      const held = !!(this.buttons & [1, 4, 2][index]!);
      const boxW = font.measureText(label) + 10;
      if (held) image.fillRect(x, boxY, boxW, font.lineHeight + 2, 200);
      else image.drawRect(x, boxY, boxW, font.lineHeight + 2, 90);
      image.drawText(font, x + 5, boxY + 1, label, held ? 1 : 170);
      x += boxW + 4;
    }
    image.drawText(font, x + 8, boxY + 1, `wheel ${this.wheel}`, 150);
    const rate = `${this.rate}/s`;
    image.drawText(font, right - font.measureText(rate), boxY + 1, rate, 110);
    const hint = "Left click marks, right click clears. Esc or double tap: back";
    image.drawText(font, left, height - padding.bottom - font.lineHeight, hint, 90);

    for (const mark of this.marks) {
      image.drawLine(mark.x - 4, mark.y, mark.x + 4, mark.y, 140);
      image.drawLine(mark.x, mark.y - 4, mark.x, mark.y + 4, 140);
    }
    if (this.x >= 0) paintPointerCursor(image, Math.round(this.x), Math.round(this.y));
    return image;
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }
}
