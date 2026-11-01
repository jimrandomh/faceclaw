import { type GrayImage, type UiFont } from "../graphics/image";
import { truncateText } from "../graphics/textwrap";
import { voiceControlBridge } from "../native/voice-control";
import { lineStep } from "./metrics";

const HEADER_X = 24;
const HEADER_Y = 20;
const TITLE_GRAY = 200;
const STATUS_GRAY = 110;

const SEGMENTS = 8;
const SEGMENT_WIDTH = 4;
const SEGMENT_GAP = 2;
const METER_GAP = 10;
const LIT_GRAY = 200;
const UNLIT_GRAY = 45;
/** How often the meter may ask for a repaint (each one is a frame over BLE). */
const TICK_MS = 200;
/** Per tick, the shown level falls to this fraction without louder audio (~1 s to empty). */
const DECAY = 0.5;

/**
 * A compact segmented mic-level meter for listening views. Levels arrive per
 * 50 ms audio chunk; the meter holds their peak and, at most every 200 ms,
 * asks for a repaint only when the number of lit segments changed and the
 * window is on screen.
 */
export class MicLevelMeter {
  readonly width = SEGMENTS * (SEGMENT_WIDTH + SEGMENT_GAP) - SEGMENT_GAP;
  private peak = 0;
  private shown = 0;
  private lit = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  start(requestRender: () => void, isVisible: () => boolean): void {
    this.unsubscribe = voiceControlBridge.onMicLevel((level) => {
      this.peak = Math.max(this.peak, level);
    });
    this.timer = setInterval(() => {
      this.shown = Math.max(this.peak, this.shown * DECAY);
      this.peak = 0;
      const lit = Math.min(SEGMENTS, Math.round(this.shown * SEGMENTS));
      if (lit === this.lit) return;
      this.lit = lit;
      if (isVisible()) requestRender();
    }, TICK_MS);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Draw the segments with their bottoms on `baseline`, `height` tall. */
  paint(image: GrayImage, x: number, baseline: number, height: number): void {
    for (let index = 0; index < SEGMENTS; index++) {
      const segmentX = x + index * (SEGMENT_WIDTH + SEGMENT_GAP);
      image.fillRect(segmentX, baseline - height, SEGMENT_WIDTH, height, index < this.lit ? LIT_GRAY : UNLIT_GRAY);
    }
  }
}

/**
 * The one-line header of the listening views (Transcribe, Translate):
 * "Title · status", the status truncated to fit, then the mic level meter at
 * the line's end when one is given (while listening). Returns the y at which
 * the view's body starts.
 */
export function paintListeningHeader(
  image: GrayImage,
  font: UiFont,
  title: string,
  status: string,
  meter: MicLevelMeter | null,
): number {
  let textRight = image.width - HEADER_X;
  if (meter) {
    const meterX = textRight - meter.width;
    // Roughly cap height, sitting on the text's baseline.
    meter.paint(image, meterX, HEADER_Y + font.ascent, Math.max(4, Math.round(font.ascent * 0.6)));
    textRight = meterX - METER_GAP;
  }
  image.drawText(font, HEADER_X, HEADER_Y, title, TITLE_GRAY);
  if (status) {
    const statusX = HEADER_X + Math.ceil(font.measureText(title));
    image.drawText(font, statusX, HEADER_Y, truncateText(font, ` · ${status}`, textRight - statusX), STATUS_GRAY);
  }
  return HEADER_Y + lineStep(font) + 2;
}
