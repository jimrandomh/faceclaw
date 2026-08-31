import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GESTURE_DOUBLE_CLICK, type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { micSession, type MicSessionState } from "./mic-session";

/**
 * Live level meters, one per active microphone (a single mixed channel on
 * stock firmware; up to four mics with the mic-control firmware), plus the
 * firmware's signal-strength/DoA readout.
 */
export class LevelsLayer implements Layer {
  private state: MicSessionState = micSession.getState();
  private unsubscribe: (() => void) | null = null;

  start(requestRender: () => void): void {
    this.unsubscribe = micSession.onState((state) => {
      this.state = state;
      requestRender();
    });
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const state = this.state;

    image.drawText(font, 12, 6, "Microphone Levels", 220);
    image.drawText(font, 12, 24, state.statusText, 110);

    const barX = 130;
    const barWidth = width - barX - 40;
    const rowHeight = 26;
    let y = 48;
    const labels = state.levelLabels.length ? state.levelLabels : ["Glasses mic"];
    labels.forEach((label, index) => {
      const level = state.levels[index] ?? 0;
      const enabled = state.levelsEnabled[index] ?? true;
      image.drawText(font, 12, y + 3, enabled ? label : `${label} (off)`, enabled ? 190 : 90);
      image.drawRect(barX, y, barWidth, 16, enabled ? 70 : 40);
      const fill = Math.round((barWidth - 4) * level);
      if (fill > 0) {
        // A disabled mic still meters (dimly) so its signal can be checked
        // before switching it back on.
        image.fillRect(barX + 2, y + 2, fill, 12, !enabled ? 70 : level > 0.85 ? 255 : 190);
      }
      // Tick marks at -20 dB and -40 dB of the 60 dB meter range.
      for (const fraction of [1 / 3, 2 / 3]) {
        const tickX = barX + Math.round(barWidth * fraction);
        image.drawLine(tickX, y + 16, tickX, y + 19, 60);
      }
      y += rowHeight;
    });

    y += 6;
    if (state.doaDeviceDeg !== null) {
      image.drawText(font, 12, y, `Direction of arrival: ${Math.round(state.doaDeviceDeg)}°`, 160);
      y += 18;
    }
    image.drawText(font, 12, y, `Signal-strength ratio: ${state.ssr}`, 130);
    y += 18;
    const ancText = state.ancOn && state.ancEngine ? `on — ${state.ancEngine}` : "off";
    image.drawText(font, 12, y, `Noise cancellation: ${ancText}`, 130);

    image.drawText(font, 12, height - font.lineHeight - 4, `${GESTURE_DOUBLE_CLICK} back`, 110);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }

  onRemoved(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
