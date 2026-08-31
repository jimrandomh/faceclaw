import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { wrapText } from "../../graphics/textwrap";
import { type AppContext } from "../app-definition";
import { isLoadableAppUrl, openEvenHubUrl } from "../evenhub";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { lineStep } from "../../ui/metrics";
import { developerAppUrlSetting } from "../../ui/dashboard-settings";
import { isQrScannerAvailable, scanQrCode } from "../../native/qr-scan";

const MARGIN = 20;

/**
 * "Load app from URL": the glasses side of the phone text editor. Entering the
 * page opens the editor on developerAppUrlSetting, the typed URL echoes here
 * as it changes, and a click (or the phone keyboard's done key) launches it as
 * an EvenHub app. The draft persists, so reloading after an edit-and-rebuild is
 * one click.
 */
export class LoadAppFromUrlLayer implements Layer {
  private error = "";
  private launching = false;

  constructor(private readonly ctx: AppContext) {}

  /** Opens the phone editor; call right after pushing the layer. */
  open(ctx: LayerContext): void {
    void ctx.actions.startTextSettingsEdit([developerAppUrlSetting], "Load app from URL", () => {
      void this.launch(ctx);
    });
  }

  /** Leaving the page by any route closes the phone editor with it. */
  onRemoved(): void {
    void this.ctx.actions.endTextSettingEdit();
  }

  /** Dictated text fills the draft, same as typing it on the phone. */
  receiveTextInput(text: string): void {
    developerAppUrlSetting.set(text);
    this.error = "";
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const step = lineStep(font);
    const textWidth = width - 2 * MARGIN;

    image.drawText(font, MARGIN, 8, "Load app from URL", 220);
    let y = 8 + step + 6;
    image.drawText(font, MARGIN, y, "Type the app's URL in the phone app", 150);
    y += step;
    image.drawText(font, MARGIN, y, "(or use voice input from the menu).", 150);
    y += step + 8;

    const url = developerAppUrlSetting.get();
    for (const line of wrapText(font, url || "(empty)", textWidth).slice(0, 3)) {
      image.drawText(font, MARGIN, y, line, url ? 230 : 110);
      y += step;
    }
    if (this.error) {
      y += 4;
      for (const line of wrapText(font, this.error, textWidth).slice(0, 2)) {
        image.drawText(font, MARGIN, y, line, 150);
        y += step;
      }
    }

    const footer = this.launching
      ? "Loading..."
      : `${GESTURE_CLICK} load   ${GESTURE_DOUBLE_CLICK} cancel`;
    image.drawText(font, MARGIN, height - font.lineHeight - 12, footer, 110);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "click":
        void this.launch(ctx);
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  private async launch(ctx: LayerContext): Promise<void> {
    if (this.launching) return;
    const url = developerAppUrlSetting.get();
    if (!isLoadableAppUrl(url)) {
      this.error = url ? "Not an http:// or https:// URL." : "Enter a URL first.";
      ctx.actions.requestRender();
      return;
    }
    this.launching = true;
    this.error = "";
    ctx.actions.requestRender();
    try {
      await openEvenHubUrl(this.ctx, url);
      ctx.stack.pop();
    } catch (error) {
      this.error = cleanError(error);
      this.ctx.appendLog(`evenhub url launch failed: ${this.error}`);
    } finally {
      this.launching = false;
      ctx.actions.requestRender();
    }
  }
}

/**
 * "Load app from QR code": hand off to an installed scanner app, then launch
 * whatever URL it decodes. The scanned URL is kept in developerAppUrlSetting so
 * the URL page can reload it later without rescanning.
 */
export class LoadAppFromQrLayer implements Layer {
  private status = "Starting scanner...";
  private busy = false;

  constructor(private readonly ctx: AppContext) {}

  /** Launches the scanner; call right after pushing the layer. */
  open(ctx: LayerContext): void {
    if (!isQrScannerAvailable()) {
      this.status = "No QR scanner on this phone (needs Play Services or a scanner app).";
      ctx.actions.requestRender();
      return;
    }
    this.busy = true;
    void this.scan(ctx);
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const step = lineStep(font);

    image.drawText(font, MARGIN, 8, "Load app from QR code", 220);
    let y = 8 + step + 6;
    for (const line of wrapText(font, this.status, width - 2 * MARGIN).slice(0, 5)) {
      image.drawText(font, MARGIN, y, line, 170);
      y += step;
    }

    const footer = this.busy ? `${GESTURE_DOUBLE_CLICK} back` : `${GESTURE_CLICK} scan again   ${GESTURE_DOUBLE_CLICK} back`;
    image.drawText(font, MARGIN, height - font.lineHeight - 12, footer, 110);
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "click":
        if (!this.busy && isQrScannerAvailable()) {
          this.busy = true;
          this.status = "Starting scanner...";
          ctx.actions.requestRender();
          void this.scan(ctx);
        }
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  private async scan(ctx: LayerContext): Promise<void> {
    try {
      this.status = "Point the phone camera at the QR code.";
      ctx.actions.requestRender();
      const scanned = await scanQrCode();
      if (scanned === null) {
        this.status = "Scan cancelled.";
        return;
      }
      if (!isLoadableAppUrl(scanned)) {
        this.status = `Not a URL: ${scanned}`;
        return;
      }
      developerAppUrlSetting.set(scanned);
      this.status = `Loading ${scanned}`;
      ctx.actions.requestRender();
      await openEvenHubUrl(this.ctx, scanned);
      ctx.stack.pop();
    } catch (error) {
      this.status = cleanError(error);
      this.ctx.appendLog(`evenhub qr launch failed: ${this.status}`);
    } finally {
      this.busy = false;
      ctx.actions.requestRender();
    }
  }
}

function cleanError(error: unknown): string {
  return String((error as Error)?.message ?? error)
    .replace(/[\x00-\x1f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
