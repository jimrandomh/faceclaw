import { ImageSource, Utils } from "@nativescript/core";
import type { FaceclawCommunicatorBridge, SurfaceOptions } from "./faceclaw-communicator";

declare const com: any;
declare const java: any;

const PREVIEW_BRIGHTEN_GAMMA = 0.7;

/**
 * The display subset of the communicator bridge: everything the dashboard
 * controller needs to composite frames and read them back for the phone
 * mirror, screenshots, and recordings. FaceclawCommunicatorBridge satisfies
 * it by construction (Pick), and PreviewDisplayTarget implements it against
 * a headless compositor with no BLE transport behind it.
 */
export type DisplayTarget = Pick<
  FaceclawCommunicatorBridge,
  | "configureCompositorScreen"
  | "configureSurface"
  | "removeSurface"
  | "setSurfaceVisible"
  | "setScreenBlanked"
  | "submitSurfaceFrame"
  | "waitForFrameFinished"
  | "getCompositePreview"
  | "saveScreenshot"
  | "startScreenRecording"
  | "recordScreenFrame"
  | "stopScreenRecording"
>;

function nonNegativeNumber(value: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

/**
 * Headless display target for preview-only mode (onboarding's "Preview Only"
 * path): hosts the same Java SurfaceCompositor a live connection uses, so
 * the whole shell/app render pipeline works with no glasses paired. Frames
 * end at the compositor; the phone mirror polls them back as usual.
 *
 * Unlike the communicator bridge, calls go straight into Java: they are all
 * quick in-memory operations, so there is no call queue and no transmit
 * backpressure to wait on.
 */
export class PreviewDisplayTarget implements DisplayTarget {
  private readonly compositor: any;

  constructor() {
    const context = Utils.android.getApplicationContext();
    if (!context) throw new Error("Android application context unavailable");
    this.compositor = new com.faceclaw.app.FaceclawPreviewCompositor(context);
  }

  /**
   * Publish the compositor as the worker isolates' frame target (they locate
   * it through the Java static, like the BLE communicator) and receive a
   * main-thread callback per applied frame — the preview path's stand-in for
   * the connected path's frame-metrics callback.
   */
  activate(onFrameComposited: () => void): void {
    this.compositor.setFrameListener(
      new java.lang.Runnable({ run: () => onFrameComposited() }),
    );
    this.compositor.makeActive();
  }

  /** Withdraw from workers and drop the frame callback. */
  release(): void {
    this.compositor.release();
  }

  async configureCompositorScreen(width: number, height: number): Promise<void> {
    this.compositor.configureCompositorScreen(Math.round(width), Math.round(height));
  }

  async configureSurface(id: string, options: SurfaceOptions): Promise<void> {
    const transparency = options.transparency === "color-key" ? 1 : 0;
    this.compositor.configureSurface(
      id,
      Math.round(options.x),
      Math.round(options.y),
      Math.round(options.width),
      Math.round(options.height),
      Math.round(options.zOrder),
      transparency,
    );
  }

  async removeSurface(id: string): Promise<void> {
    this.compositor.removeSurface(id);
  }

  async setSurfaceVisible(id: string, visible: boolean): Promise<void> {
    this.compositor.setSurfaceVisible(id, Boolean(visible));
  }

  async setScreenBlanked(blanked: boolean): Promise<void> {
    this.compositor.setScreenBlanked(Boolean(blanked));
  }

  async submitSurfaceFrame(
    surfaceId: string,
    pixels8bpp: Uint8Array,
    rect: { x: number; y: number; width: number; height: number },
    fingerprint: string,
    paintMs = -1,
    frameId = 0,
    glyphs: ArrayBuffer | null = null,
  ): Promise<void> {
    // Copy for the same reason the bridge does: the source may be a view on a
    // larger buffer, and Java receives the backing ArrayBuffer.
    const snapshot = new Uint8Array(pixels8bpp);
    this.compositor.submitSurfaceFrame(
      snapshot.buffer,
      surfaceId,
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height),
      fingerprint,
      Math.round(nonNegativeNumber(paintMs)),
      Math.round(nonNegativeNumber(frameId)),
      glyphs,
    );
    // The Java side finishes the frame: the composite is the end of the line,
    // and worker isolates submit to the same object without coming through here.
  }

  /** Composites are synchronous and nothing transmits, so there is never backpressure. */
  waitForFrameFinished(): Promise<string | null> {
    return Promise.resolve("composited");
  }

  getCompositePreview(green = false): ImageSource | null {
    if (!global.isAndroid) return null;
    const bitmap = this.compositor.getCompositePreviewBitmap(PREVIEW_BRIGHTEN_GAMMA, green);
    return bitmap ? new ImageSource(bitmap) : null;
  }

  saveScreenshot(crop?: { x: number; y: number; width: number; height: number }): string {
    if (!global.isAndroid) return "";
    if (!crop) return String(this.compositor.saveCompositePngScreenshot());
    return String(
      this.compositor.saveCompositePngScreenshot(
        Math.round(crop.x),
        Math.round(crop.y),
        Math.round(crop.width),
        Math.round(crop.height),
      ),
    );
  }

  startScreenRecording(): void {
    if (!global.isAndroid) return;
    this.compositor.startScreenRecording();
  }

  recordScreenFrame(): void {
    if (!global.isAndroid) return;
    this.compositor.recordScreenFrame();
  }

  stopScreenRecording(): string {
    if (!global.isAndroid) return "";
    return String(this.compositor.stopScreenRecording());
  }
}
