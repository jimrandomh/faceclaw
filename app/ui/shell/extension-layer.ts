import { GrayImage } from "../../graphics/image";
import type { InputEvent } from "../gestures";
import type { Layer, LayerContext, PaintBelow } from "../layers";
import { appViewportRect, type WindowHeightMode } from "./geometry";

/** Receives only private raster snapshots already checked by the native adapter. */
export class ExtensionLayer implements Layer {
  readonly acceptsDirectional = true;
  get dimUnderneath(): false | number { return this.opaque && this.frame ? 0 : false; }
  opaque: boolean;
  private frame: GrayImage | undefined;
  get readyForDisplay(): boolean { return this.frame !== undefined; }
  constructor(
    private readonly input: (event: InputEvent) => void,
    private readonly resized: (width: number, height: number) => void,
    private readonly closed: () => void,
    private readonly heightMode: WindowHeightMode = "min",
    opaque = true,
    public alignTop = false,
  ) { this.opaque = opaque; }
  private size = "";
  setFrame(pixels: Uint8Array, width: number, height: number): void {
    const frame = new GrayImage(width, height, 0);
    frame.pixels.set(pixels);
    this.frame = frame;
  }
  paint(_ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const image = paintBelow();
    const rect = { ...appViewportRect(this.heightMode) };
    if (this.alignTop) rect.y = 0;
    const size = `${rect.width}:${rect.height}`;
    if (size !== this.size) { this.size = size; this.frame = undefined; this.resized(rect.width, rect.height); }
    if (this.opaque && this.frame) image.fillRect(rect.x, rect.y, rect.width, rect.height, 1);
    if (this.frame?.width === rect.width && this.frame.height === rect.height) {
      image.bitBlt(this.frame, rect.x, rect.y, { transparentZero: !this.opaque });
    }
    return image;
  }
  handleInput(event: InputEvent): void { this.input(event); }
  onRemoved(): void { this.frame = undefined; this.closed(); }
}
