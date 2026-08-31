/**
 * The compass calibration screen: a crosshair the wearer aims at a landmark
 * of known heading, plus raw/offset/calibrated readouts. Swipe adjusts the
 * offset by 1°, double-tap returns to the compass.
 */
import { GrayImage } from "../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { wrapText } from "../../graphics/textwrap";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { lineStep } from "../../ui/metrics";
import { screenCenterInViewportX } from "../../ui/shell/geometry";
import {
  formatOffset,
  getCompassOffset,
  markCompassCalibrated,
  normalizeHeading,
  setCompassOffset,
} from "./calibration";

const INSTRUCTIONS =
  "This compass uses the magnetometer in the right arm of the glasses; depending how it rests on your head, "
  + "it may be slightly off. To calibrate, look at a distant object or down a street where you know the true "
  + "compass heading, then adjust the calibration offset below";

/** Margins around the instruction paragraph. */
const TEXT_PADDING_X = 16;
const TEXT_PADDING_TOP = 10;

export class CompassCalibrationLayer implements Layer {
  constructor(
    /** Current uncorrected magnetometer heading, or null before the first reading. */
    private readonly getRawHeading: () => number | null,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const smallStep = lineStep(small);

    const lines = wrapText(small, INSTRUCTIONS, width - TEXT_PADDING_X * 2);
    for (let i = 0; i < lines.length; i++) {
      image.drawText(small, TEXT_PADDING_X, TEXT_PADDING_TOP + i * smallStep, lines[i]!, 190);
    }
    const textBottom = TEXT_PADDING_TOP + lines.length * smallStep;

    // Readouts along the bottom: dim label over a bright value, in thirds.
    const valueTop = height - medium.lineHeight;
    const labelTop = valueTop - small.lineHeight;
    const raw = this.getRawHeading();
    const offset = getCompassOffset();
    const columns: Array<[string, string]> = [
      ["Raw", raw === null ? "--°" : `${Math.round(raw)}°`],
      ["Offset", formatOffset(offset)],
      ["Calibrated", raw === null ? "--°" : `${Math.round(normalizeHeading(raw + offset))}°`],
    ];
    const columnWidth = width / columns.length;
    for (let i = 0; i < columns.length; i++) {
      const [label, value] = columns[i]!;
      const center = columnWidth * (i + 0.5);
      image.drawText(small, Math.round(center - small.measureText(label) / 2), labelTop, label, 130);
      image.drawText(medium, Math.round(center - medium.measureText(value) / 2), valueTop, value, 255);
    }

    // The crosshair marks where the wearer is looking, so its horizontal
    // position must be the true centre of the display, not of the app
    // viewport the sidebar has pushed to the right. Vertically it just sits in
    // the free space between the instructions and the readouts; the window
    // band's own placement on screen is the wearer's Display setting and
    // doesn't affect the heading being aimed.
    const crosshairX = screenCenterInViewportX();
    const crosshairY = Math.round((textBottom + labelTop) / 2);
    drawCrosshair(image, crosshairX, crosshairY);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "scroll-up") {
      this.adjust(1);
    } else if (event.type === "scroll-down") {
      this.adjust(-1);
    } else if (event.type === "double-click") {
      // Leaving the screen counts as accepting the calibration, so an offset
      // the wearer decides is already correct still clears the prompt.
      markCompassCalibrated();
      ctx.stack.pop();
    }
  }

  private adjust(delta: number): void {
    setCompassOffset(getCompassOffset() + delta);
    markCompassCalibrated();
  }
}

/** A gapped crosshair: four arms around an open centre with a ring. */
function drawCrosshair(image: GrayImage, cx: number, cy: number): void {
  const gap = 5;
  const arm = 16;
  const radius = 9;
  image.drawLine(cx - gap - arm, cy, cx - gap, cy, 255);
  image.drawLine(cx + gap, cy, cx + gap + arm, cy, 255);
  image.drawLine(cx, cy - gap - arm, cx, cy - gap, 255);
  image.drawLine(cx, cy + gap, cx, cy + gap + arm, 255);
  for (let angle = 0; angle < 360; angle += 6) {
    const radians = (angle * Math.PI) / 180;
    image.setPixel(Math.round(cx + Math.cos(radians) * radius), Math.round(cy + Math.sin(radians) * radius), 180);
  }
  image.setPixel(cx, cy, 255);
}
