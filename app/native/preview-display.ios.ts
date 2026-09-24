import { File, knownFolders, path, type ImageSource } from "@nativescript/core";
import { SurfaceCompositor } from "../graphics/surface-compositor";
import { G2_LENS_WIDTH, G2_LENS_HEIGHT } from "../graphics/image";
import { previewPixels } from "./ios-graphics";
import { toData } from "./kotlin-data";
import type { FaceclawCommunicatorBridge, SurfaceOptions } from "./faceclaw-communicator.ios";

declare const FaceclawKitIosProtocol: any;

/** The display subset of the communicator bridge; see the Android twin. */
export type DisplayTarget = Pick<
  FaceclawCommunicatorBridge,
  | "configureCompositorScreen"
  | "configureSurface"
  | "removeSurface"
  | "setSurfaceVisible"
  | "setSurfaceDepth"
  | "setUnderlayDim"
  | "setScreenBlanked"
  | "submitSurfaceFrame"
  | "submitShellScene"
  | "waitForFrameFinished"
  | "getCompositePreview"
  | "saveScreenshot"
  | "startScreenRecording"
  | "recordScreenFrame"
  | "stopScreenRecording"
>;

function timestamp(): string {
  const now = new Date();
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
}

/**
 * Headless display target for iOS while no glasses session exists: the same
 * shared Kotlin SurfaceCompositor a live session composes with, so the phone
 * mirror, apps and shell render identically before connecting. Frames end
 * at the compositor; there is no transmit backpressure to wait on.
 */
export class PreviewDisplayTarget implements DisplayTarget {
  private compositor = new SurfaceCompositor(G2_LENS_WIDTH, G2_LENS_HEIGHT);
  private onFrameComposited: (() => void) | null = null;
  private released = false;

  /** Receive a callback per applied frame, the stand-in for the connected path's frame-finished callback. */
  activate(onFrameComposited: () => void): void {
    this.onFrameComposited = onFrameComposited;
  }

  release(): void {
    this.released = true;
    this.onFrameComposited = null;
  }

  private composited(): void {
    if (!this.released) this.onFrameComposited?.();
  }

  async configureCompositorScreen(width: number, height: number): Promise<void> {
    if (Math.round(width) !== this.compositor.width || Math.round(height) !== this.compositor.height) {
      this.compositor = new SurfaceCompositor(Math.round(width), Math.round(height));
    }
  }

  async configureSurface(id: string, options: SurfaceOptions): Promise<void> {
    this.compositor.configureSurface(id, {
      x: Math.round(options.x), y: Math.round(options.y), width: Math.round(options.width), height: Math.round(options.height),
      zOrder: Math.round(options.zOrder), transparency: options.transparency,
    });
  }

  async removeSurface(id: string): Promise<void> {
    this.compositor.removeSurface(id);
    this.composited();
  }

  async setSurfaceVisible(id: string, visible: boolean): Promise<void> {
    this.compositor.setSurfaceVisible(id, Boolean(visible));
    this.composited();
  }

  async setSurfaceDepth(id: string, depth: number): Promise<void> {
    this.compositor.setSurfaceDepth(id, Math.round(depth));
  }

  async setUnderlayDim(belowZOrder: number, factor: number): Promise<void> {
    this.compositor.setUnderlayDim(Math.round(belowZOrder), Math.max(0, Math.min(1, factor)));
    this.composited();
  }

  async setScreenBlanked(blanked: boolean): Promise<void> {
    this.compositor.setScreenBlanked(Boolean(blanked));
    this.composited();
  }

  async submitSurfaceFrame(
    surfaceId: string,
    pixels8bpp: Uint8Array,
    rect: { x: number; y: number; width: number; height: number },
    _fingerprint: string,
    _paintMs = -1,
    _frameId = 0,
    glyphs: ArrayBuffer | null = null,
  ): Promise<void> {
    this.compositor.submitSurfaceFrame(surfaceId, pixels8bpp,
      { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, glyphs);
    this.composited();
  }

  async submitShellScene(bytes: Uint8Array, _paintMs = 0, _frameId = 0): Promise<void> {
    this.compositor.setShellScene(bytes);
    this.composited();
  }

  /** Nothing transmits: every frame is finished as soon as it is composited. */
  waitForFrameFinished(frameId: number, _timeoutMs: number): Promise<string | null> {
    return Promise.resolve(frameId > 0 ? "composited" : null);
  }

  /** The current composite as gray pixels (row-major, compositor size). */
  composite(): Uint8Array {
    return this.compositor.composite();
  }

  getCompositePreview(green = false): ImageSource | null {
    return previewPixels(this.compositor.composite(), this.compositor.width, this.compositor.height, green);
  }

  /** Save the current composite as a 4-bit grayscale PNG under Documents; cropping is not supported on iOS. */
  saveScreenshot(crop?: { x: number; y: number; width: number; height: number }): string {
    if (crop) return "";
    const png = FaceclawKitIosProtocol.new().pngDataWidthHeight(toData(this.compositor.composite()), this.compositor.width, this.compositor.height);
    if (!png) return "";
    const target = path.join(knownFolders.documents().path, `screen-${timestamp()}.png`);
    File.fromPath(target).writeSync(png);
    return target;
  }

  startScreenRecording(): void {}

  recordScreenFrame(): void {}

  stopScreenRecording(): string { return ""; }
}
