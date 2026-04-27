import { GrayImage } from "../graphics/image";
import { wrapText } from "../graphics/textwrap";
import { DashboardInputEvent, Layer, LayerContext, PaintBelow } from "./layers";

const DEFAULT_MENU_X = 48;
const DEFAULT_MENU_Y = 24;
const DEFAULT_MENU_WIDTH = 480;
const DEFAULT_MENU_HEIGHT = 240;
const MENU_TITLE_HEIGHT = 24;
const MENU_ROW_HEIGHT = 28;

export type MenuLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MenuItemRenderArgs = {
  image: GrayImage;
  x: number;
  y: number;
  width: number;
  height: number;
  selected: boolean;
  text: string;
  ctx: LayerContext;
};

export type MenuItem = {
  label: string;
  onSelect: (ctx: LayerContext, menu: MenuLayer) => Promise<void> | void;
  render?: (args: MenuItemRenderArgs) => void;
};

export class MenuLayer implements Layer {
  private selectedIndex = 0;

  constructor(
    private readonly title: string,
    private readonly items: MenuItem[],
    private readonly layout: MenuLayout = {
      x: DEFAULT_MENU_X,
      y: DEFAULT_MENU_Y,
      width: DEFAULT_MENU_WIDTH,
      height: DEFAULT_MENU_HEIGHT,
    },
    public readonly paintOverBase = false,
  ) {}

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const { x, y, width, height } = this.layout;
    const image = paintBelow();
    image.fillRoundedRect(x, y, width, height, 0);
    image.drawRoundedRect(x, y, width, height, 72);
    image.drawText(ctx.font, x + 18, y + 10, this.title, 220);

    const bodyY = y + MENU_TITLE_HEIGHT + 12;
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index]!;
      const y = bodyY + index * MENU_ROW_HEIGHT;
      const selected = index === this.selectedIndex;
      if (selected) {
        image.fillRoundedRect(x + 12, y - 2, width - 24, MENU_ROW_HEIGHT - 4, 18);
        image.drawRoundedRect(x + 12, y - 2, width - 24, MENU_ROW_HEIGHT - 4, 45);
      }
      if (item.render) {
        item.render({
          image,
          x: x + 22,
          y,
          width: width - 44,
          height: MENU_ROW_HEIGHT - 4,
          selected,
          text: item.label,
          ctx,
        });
      } else {
        image.drawText(ctx.font, x + 22, y + 4, item.label, selected ? 255 : 200);
      }
    }

    return image;
  }

  async handleInput(event: DashboardInputEvent, ctx: LayerContext): Promise<void> {
    if (!this.items.length) {
      if (event.type === "double-click") {
        ctx.stack.pop();
      }
      return;
    }
    switch (event.type) {
      case "scroll-up":
        this.selectedIndex = (this.selectedIndex + this.items.length - 1) % this.items.length;
        return;
      case "scroll-down":
        this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      case "click":
        await this.items[this.selectedIndex]!.onSelect(ctx, this);
        return;
      default:
        return;
    }
  }
}

export class TextPageLayer implements Layer {
  constructor(
    private readonly title: string,
    private readonly body: string,
  ) {}

  paint(ctx: LayerContext): GrayImage {
    const image = new GrayImage(576, 288, 0);
    image.drawText(ctx.font, 18, 14, this.title, 220);
    image.drawRect(12, 12, 552, 264, 52);

    const wrapped = wrapText(ctx.font, this.body, 520);
    for (let index = 0; index < wrapped.length; index++) {
      image.drawText(ctx.font, 24, 42 + index * 14, wrapped[index]!, 190);
    }
    image.drawText(ctx.font, 24, 252, "Double-click to go back", 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }
}
