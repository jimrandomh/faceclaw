import { GrayImage } from "../../graphics/image";
import { flattenPlanes } from "../../graphics/plane";
import { InputEvent } from "../gestures";
import { Layer, LayerActions, LayerContext, LayerStack, PaintBelow } from "../layers";
import { appViewportRect, appViewportSize, SHELL_OPAQUE_BLACK } from "./geometry";

// The modal covers most of the min-height app viewport, leaving a little of
// the foreground app visible around the edges. Both its size and position are
// computed per paint: the display-mode setting changes the viewport size at
// runtime, and the vertical position setting moves the band.
const MODAL_MARGIN = 14;
const MODAL_PADDING = 4;

/** Content (inner layer stack) size of the modal box. */
function modalInterior(): { width: number; height: number } {
  const viewport = appViewportSize("min");
  return {
    width: viewport.width - 2 * MODAL_MARGIN - 2 * MODAL_PADDING,
    height: viewport.height - 2 * MODAL_MARGIN - 2 * MODAL_PADDING,
  };
}

/** Screen rect of the modal box, aligned to the min-height window band. */
export function modalRect(): { x: number; y: number; width: number; height: number } {
  const viewport = appViewportRect("min");
  return {
    x: viewport.x + MODAL_MARGIN,
    y: viewport.y + MODAL_MARGIN,
    width: viewport.width - 2 * MODAL_MARGIN,
    height: viewport.height - 2 * MODAL_MARGIN,
  };
}

/**
 * A shell overlay hosting an inner layer stack in a bordered box over the
 * app viewport (used for new-notification popups). The inner stack paints at
 * the modal's interior size; its pixels blit onto an opaque black backdrop,
 * so inner value-0 pixels read as black, not transparent.
 */
export class ShellModalLayer implements Layer {
  private readonly stack: LayerStack;

  constructor(baseLayer: Layer, actions: LayerActions) {
    this.stack = new LayerStack(baseLayer, actions, modalInterior());
  }

  paint(_ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const image = paintBelow();
    // Track a display-mode switch while the modal is up, so the inner stack
    // paints at the same size the box below is drawn with.
    const interior = modalInterior();
    this.stack.setBaseSize(interior);
    // Flattening bakes the inner stack's planes (glyphs included) so the blit
    // below transplants the finished modal content into this layer's plane.
    const inner = flattenPlanes(this.stack.paint(), interior);
    const rect = modalRect();
    image.fillRoundedRect(rect.x, rect.y, rect.width, rect.height, SHELL_OPAQUE_BLACK, 8);
    image.drawRoundedRect(rect.x, rect.y, rect.width, rect.height, 110, 8);
    image.bitBlt(inner, rect.x + MODAL_PADDING, rect.y + MODAL_PADDING, { transparentZero: true });
    return image;
  }

  async handleInput(event: InputEvent, _ctx: LayerContext): Promise<void> {
    await this.stack.handleInput(event);
  }
}
