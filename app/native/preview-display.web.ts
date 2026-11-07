import { WebSurfaceCompositor } from "faceclaw-kit";
import type { SurfaceOptions } from "./faceclaw-communicator";

export type DisplayTarget = PreviewDisplayTarget;

const signed = (bytes: Uint8Array | ArrayBuffer): Int8Array =>
  bytes instanceof ArrayBuffer ? new Int8Array(bytes) : new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * The browser's display target: the shared Kotlin SurfaceCompositor, like the
 * phones' preview mode. Frames end here, and the page reads them back with
 * composite(). Nothing transmits, so nothing ever waits.
 */
export class PreviewDisplayTarget {
  private compositor: WebSurfaceCompositor;
  private onFrameComposited: (() => void) | null = null;

  constructor(public width: number, public height: number) {
    this.compositor = new WebSurfaceCompositor(width, height);
  }

  /** A callback per applied frame and per step of an animation the preview is replaying. */
  activate(onFrameComposited: () => void): void {
    this.onFrameComposited = onFrameComposited;
    this.compositor.setPreviewAnimationListener(onFrameComposited);
  }

  private composited(): void {
    this.onFrameComposited?.();
  }

  async configureCompositorScreen(width: number, height: number): Promise<void> {
    if (width === this.width && height === this.height) return;
    this.compositor.setPreviewAnimationListener(null);
    this.width = width;
    this.height = height;
    this.compositor = new WebSurfaceCompositor(width, height);
    if (this.onFrameComposited) this.compositor.setPreviewAnimationListener(this.onFrameComposited);
  }

  async configureSurface(id: string, options: SurfaceOptions): Promise<void> {
    this.compositor.configure(id, Math.round(options.x), Math.round(options.y), Math.round(options.width), Math.round(options.height),
      Math.round(options.zOrder), options.transparency === "color-key");
  }

  async removeSurface(id: string): Promise<void> {
    this.compositor.remove(id);
    this.composited();
  }

  async setSurfaceVisible(id: string, visible: boolean): Promise<void> {
    if (!this.compositor.hasSurface(id)) return;
    this.compositor.visible(id, Boolean(visible));
    this.composited();
  }

  async setSurfaceDepth(id: string, depth: number): Promise<void> {
    if (this.compositor.hasSurface(id)) this.compositor.depth(id, Math.round(depth));
  }

  async setUnderlayDim(belowZOrder: number, factor: number): Promise<void> {
    this.compositor.dim(Math.round(belowZOrder), factor);
    this.composited();
  }

  async setScreenBlanked(blanked: boolean): Promise<void> {
    this.compositor.blank(Boolean(blanked));
    this.composited();
  }

  async submitSurfaceFrame(surfaceId: string, pixels8bpp: Uint8Array,
    rect: { x: number; y: number; width: number; height: number }, _fingerprint?: string, _paintMs?: number,
    _frameId?: number, draws: ArrayBuffer | null = null): Promise<void> {
    // A frame racing its window's close, as on the phones, is dropped.
    if (!this.compositor.hasSurface(surfaceId)) return;
    this.compositor.submit(surfaceId, signed(pixels8bpp), Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height),
      draws ? signed(draws) : null);
    this.composited();
  }

  async submitShellScene(bytes: Uint8Array): Promise<void> {
    this.compositor.shell(signed(bytes));
    this.composited();
  }

  /** The current composite as gray pixels (row-major, compositor size). */
  composite(): Uint8Array {
    const gray = this.compositor.composite();
    return new Uint8Array(gray.buffer, gray.byteOffset, gray.byteLength);
  }
}
