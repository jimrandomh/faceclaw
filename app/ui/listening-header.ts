import { GrayImage, imageFromAsciiArt, type UiFont } from "../graphics/image";
import { truncateText } from "../graphics/textwrap";
import { voiceControlBridge } from "../native/voice-control";
import { lineStep } from "./metrics";
import type { Edges } from "./viewport";

const TITLE_GRAY = 200;
const STATUS_GRAY = 110;

const SEGMENTS = 8;
const SEGMENT_WIDTH = 4;
const SEGMENT_GAP = 2;
const METER_GAP = 10;
/** Between the recording circle and the meter. */
const RECORDING_ICON_GAP = 4;
/** Between a tray icon and its recording circle: tight, so they read as one item in the bar. */
const TRAY_RECORDING_ICON_GAP = 2;
const LIT_GRAY = 200;
const UNLIT_GRAY = 45;
/** How often the meter may ask for a repaint (each one is a frame over BLE). */
const TICK_MS = 200;
/** Per tick, the shown level falls to this fraction without louder audio (~1 s to empty). */
const DECAY = 0.5;

/** The listening views' status while Save Recording is on but its file could not be created. */
export const RECORDING_FAILED_NOTICE = "Recording failed (check file access).";

/**
 * 9x9 filled circle: the mic's audio is being saved (Save Recording, in the
 * Transcribe and Translate menus). Shown beside the mic level meter and the
 * mic tray icon, and on Glanceboard's system card.
 */
export const RECORDING_ICON = imageFromAsciiArt(
  [
    "   ###   ",
    " ####### ",
    " ####### ",
    "#########",
    "#########",
    "#########",
    " ####### ",
    " ####### ",
    "   ###   ",
  ],
  { "#": 220 },
);

/** `icon` with the recording circle to its right: a tray icon while its app's audio is saved. */
export function withRecordingIcon(icon: GrayImage): GrayImage {
  const circleX = icon.width + TRAY_RECORDING_ICON_GAP;
  const image = new GrayImage(circleX + RECORDING_ICON.width, Math.max(icon.height, RECORDING_ICON.height), 0);
  image.bitBlt(icon, 0, (image.height - icon.height) >> 1);
  image.bitBlt(RECORDING_ICON, circleX, (image.height - RECORDING_ICON.height) >> 1);
  return image;
}

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
 * the line's end when one is given (while listening), with the recording
 * circle before it while the audio it shows is being saved. It spans the
 * image inside `padding`, the padding suggested for the window's edges
 * (viewport.ts). Returns the y at which the view's body starts.
 */
export function paintListeningHeader(
  image: GrayImage,
  font: UiFont,
  title: string,
  status: string,
  meter: MicLevelMeter | null,
  padding: Edges<number>,
  recording = false,
): number {
  const x = padding.left, y = padding.top;
  let textRight = image.width - padding.right;
  if (meter) {
    const meterX = textRight - meter.width;
    // Roughly cap height, sitting on the text's baseline.
    const baseline = y + font.ascent;
    const meterHeight = Math.max(4, Math.round(font.ascent * 0.6));
    meter.paint(image, meterX, baseline, meterHeight);
    textRight = meterX - METER_GAP;
    if (recording) {
      const iconX = meterX - RECORDING_ICON_GAP - RECORDING_ICON.width;
      // Centred on the meter's height.
      image.drawImage(RECORDING_ICON, iconX, Math.round(baseline - (meterHeight + RECORDING_ICON.height) / 2));
      textRight = iconX - METER_GAP;
    }
  }
  image.drawText(font, x, y, title, TITLE_GRAY);
  if (status) {
    const statusX = x + Math.ceil(font.measureText(title));
    image.drawText(font, statusX, y, truncateText(font, ` · ${status}`, textRight - statusX), STATUS_GRAY);
  }
  return y + lineStep(font) + 2;
}
