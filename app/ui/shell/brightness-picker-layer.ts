import type { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { clamp } from "../../util/numeric-util";
import { brightnessSetting, brightnessSettingToLevel, type BrightnessSetting } from "../dashboard-settings";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, gestureHints, type InputEvent } from "../gestures";
import type { Layer, LayerContext, PaintBelow } from "../layers";
import { appViewportRect, SHELL_OPAQUE_BLACK } from "./geometry";

const DIALOG_WIDTH = 272;
const BAR_WIDTH = 12;
const BAR_HEIGHT = 100;

/** Manual brightness changes apply immediately so the wearer can judge the level. */
export class BrightnessPickerLayer implements Layer {
  constructor(private readonly onClosed: () => void) {}

  onRemoved(): void {
    this.onClosed();
  }

  paint(_ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const image = paintBelow();
    const font = getDefaultSmallFont();
    const viewport = appViewportRect("min");
    const height = BAR_HEIGHT + 3 * font.lineHeight + 56;
    const left = viewport.x + Math.round((viewport.width - DIALOG_WIDTH) / 2);
    const top = viewport.y + Math.round((viewport.height - height) / 2);
    image.fillRoundedRect(left, top, DIALOG_WIDTH, height, SHELL_OPAQUE_BLACK, 8);
    image.drawRoundedRect(left, top, DIALOG_WIDTH, height, 110, 8);

    const centeredText = (text: string, y: number, value: number) => {
      image.drawText(font, left + Math.round((DIALOG_WIDTH - font.measureText(text)) / 2), y, text, value);
    };
    centeredText("Brightness", top + 12, 235);
    const barX = left + Math.round((DIALOG_WIDTH - BAR_WIDTH) / 2);
    const barY = top + font.lineHeight + 24;
    const level = brightnessSettingToLevel(brightnessSetting.get());
    image.drawRect(barX - 2, barY - 2, BAR_WIDTH + 4, BAR_HEIGHT + 4, 150);
    const filledHeight = Math.round(BAR_HEIGHT * (level ?? 0) / 100);
    image.fillRect(barX, barY + BAR_HEIGHT - filledHeight, BAR_WIDTH, filledHeight, 255);
    image.drawText(font, barX + BAR_WIDTH + 12, barY + Math.round((BAR_HEIGHT - font.lineHeight) / 2),
      level === null ? "Auto" : `${level}%`, 235);
    centeredText(gestureHints([[GESTURE_SCROLL, "adjust"]]), barY + BAR_HEIGHT + 12, 150);
    centeredText(gestureHints([[`${GESTURE_CLICK} / ${GESTURE_DOUBLE_CLICK}`, "confirm"]]),
      barY + BAR_HEIGHT + font.lineHeight + 16, 150);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-up":
      case "scroll-down": {
        const level = brightnessSettingToLevel(brightnessSetting.get());
        // Respect Auto if it was enabled on the phone while this dialog was open.
        if (level === null) return;
        const next = clamp(level + (event.type === "scroll-up" ? 10 : -10), 0, 100);
        if (next !== level) brightnessSetting.set(String(next) as BrightnessSetting);
        return;
      }
      case "click":
      case "double-click":
        ctx.stack.pop();
        return;
    }
  }
}
