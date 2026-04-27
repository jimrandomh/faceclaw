import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../graphics/image";
import { BdfFont } from "../graphics/bdffont";

export type DashboardInputEvent =
  | { type: "click"; source: "ring" | "left-arm" | "right-arm" }
  | { type: "double-click"; source: "ring" | "left-arm" | "right-arm" }
  | { type: "scroll-up" }
  | { type: "scroll-down" }
  | { type: "unknown"; kind: string; eventSource: number; eventType: number };

export type LayerActions = {
  disconnect: () => Promise<void> | void;
  startSystemNameEdit: () => Promise<void> | void;
  endSystemNameEdit: () => Promise<void> | void;
  startNightscoutSiteUrlEdit: () => Promise<void> | void;
  startNightscoutApiTokenEdit: () => Promise<void> | void;
  endTextSettingEdit: () => Promise<void> | void;
};

export type PaintBelow = () => GrayImage;

export interface LayerContext {
  readonly stack: LayerStack;
  readonly font: BdfFont;
  readonly actions: LayerActions;
}

export interface Layer {
  readonly paintOverBase?: boolean;
  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage;
  handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> | void;
}

export class LayerStack {
  private readonly layers: Layer[];
  private readonly ctx: LayerContext;

  constructor(baseLayer: Layer, font: BdfFont, actions: LayerActions) {
    this.layers = [baseLayer];
    this.ctx = {
      stack: this,
      font,
      actions,
    };
  }

  push(layer: Layer): void {
    this.layers.push(layer);
  }

  pop(): void {
    if (this.layers.length > 1) {
      this.layers.pop();
    }
  }

  clearToBase(): void {
    this.layers.splice(1);
  }

  setActions(actions: Partial<LayerActions>): void {
    Object.assign(this.ctx.actions, actions);
  }

  paint(): GrayImage {
    return this.paintLayer(this.layers.length - 1);
  }

  async handleInput(event: DashboardInputEvent): Promise<void> {
    await this.layers[this.layers.length - 1]!.handleInput(event, this.ctx);
  }

  private paintLayer(index: number): GrayImage {
    const layer = this.layers[index]!;
    let cachedBelow: GrayImage | null = null;
    return layer.paint(this.ctx, () => {
      if (cachedBelow) {
        return cachedBelow;
      }
      if (index <= 0) {
        cachedBelow = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
      } else if (layer.paintOverBase) {
        cachedBelow = this.paintLayer(0);
      } else {
        cachedBelow = this.paintLayer(index - 1);
      }
      return cachedBelow;
    });
  }
}
