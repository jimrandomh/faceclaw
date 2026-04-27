import { GrayImage } from "../graphics/image";
import { wrapText } from "../graphics/textwrap";
import { type BdfFont } from "../graphics/bdffont";
import { DashboardInputEvent, Layer, LayerContext, PaintBelow } from "./layers";

const DEFAULT_MENU_X = 8;
const DEFAULT_MENU_Y = 8;
const DEFAULT_MENU_WIDTH = 272;
const DEFAULT_MENU_HEIGHT = 128;
const MENU_TITLE_HEIGHT = 20;
const MENU_ROW_HEIGHT = 20;

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

export function drawToggleMenuItem(
  image: GrayImage,
  font: BdfFont,
  x: number,
  y: number,
  width: number,
  label: string,
  enabled: boolean,
  selected: boolean,
): void {
  const switchWidth = 34;
  const switchHeight = 16;
  const switchX = x + width - switchWidth - 2;
  const switchY = y + 2;
  image.drawText(font, x, y + 3, label, 200);
  const offFill = selected ? 0 : 18;
  image.fillRoundedRect(switchX, switchY, switchWidth, switchHeight, enabled ? 70 : offFill, 8);
  image.drawRoundedRect(switchX, switchY, switchWidth, switchHeight, enabled ? 130 : 55, 8);
  const knobSize = 12;
  const knobX = enabled ? switchX + switchWidth - knobSize - 2 : switchX + 2;
  image.fillRoundedRect(knobX, switchY + 2, knobSize, knobSize, enabled ? 230 : selected ? 170 : 90, 6);
}

export function drawRightValueMenuItem(
  image: GrayImage,
  font: BdfFont,
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
): void {
  image.drawText(font, x, y + 3, label, 200);
  const valueX = x + width - font.measureText(value) - 2;
  image.drawText(font, valueX, y + 3, value, 220);
}

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

    const bodyY = y + MENU_TITLE_HEIGHT + 8;
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index]!;
      const y = bodyY + index * MENU_ROW_HEIGHT;
      const selected = index === this.selectedIndex;
      if (selected) {
        image.fillRoundedRect(x + 12, y - 1, width - 24, MENU_ROW_HEIGHT - 3, 18);
        image.drawRoundedRect(x + 12, y - 1, width - 24, MENU_ROW_HEIGHT - 3, 45);
      }
      if (item.render) {
        item.render({
          image,
          x: x + 22,
          y,
          width: width - 44,
          height: MENU_ROW_HEIGHT - 3,
          selected,
          text: item.label,
          ctx,
        });
      } else {
        image.drawText(ctx.font, x + 22, y + 3, item.label, selected ? 255 : 200);
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
