import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext, type PaintBelow } from "../../ui/layers";
import { drawSelectionHighlight } from "../../ui/menu";
import { LIST_ROW_TEXT_INSET, lineStep, listRowHeight } from "../../ui/metrics";

const DIALOG_X = 8;
const DIALOG_Y = 8;
const DIALOG_WIDTH = 272;
const PADDING = 10;

const SERVICE_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  soniox: "Soniox",
  elevenlabs: "ElevenLabs",
  mapbox: "Mapbox",
};

export type ApiKeyRequestItem = { id: string; configured: boolean };

/**
 * Consent dialog shown when an EvenHub app calls requestApiKeyAccess: lists the
 * requested API-key services (marking any the user hasn't configured) and asks
 * Allow / Deny. Allow shares the configured keys' values with the app; Deny (or
 * double-click) shares nothing.
 */
export class EvenHubApiKeyDialogLayer implements Layer {
  /** 0 = Allow, 1 = Deny. */
  private selectedIndex = 0;
  private resolved = false;

  constructor(
    private readonly appName: string,
    private readonly services: ApiKeyRequestItem[],
    private readonly onConfirm: () => void,
    private readonly onCancel: () => void,
  ) {}

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const font = getDefaultSmallFont();
    const { height: viewportHeight } = ctx.stack.getBaseSize();
    const image = paintBelow();
    const textWidth = DIALOG_WIDTH - 2 * PADDING - 4;
    const left = DIALOG_X + PADDING + 2;

    const headerStep = lineStep(font) + 2;
    const serviceStep = lineStep(font) + 1;
    const actionRowH = listRowHeight(font);
    const bodyTop = PADDING + headerStep + 6 + this.services.length * serviceStep + 8;
    const height = Math.min(bodyTop + 2 * actionRowH + PADDING, viewportHeight - 2 * DIALOG_Y);

    image.fillRoundedRect(DIALOG_X, DIALOG_Y, DIALOG_WIDTH, height, 1);
    image.drawRoundedRect(DIALOG_X, DIALOG_Y, DIALOG_WIDTH, height, 72);

    let y = DIALOG_Y + PADDING;
    image.drawText(font, left, y, truncateText(font, `${this.appName} wants your keys:`, textWidth), 235);
    y += headerStep + 6;

    for (const service of this.services) {
      const label = SERVICE_LABELS[service.id] ?? service.id;
      const text = service.configured ? label : `${label} (not set)`;
      image.drawText(font, left + 8, y, truncateText(font, text, textWidth - 8), service.configured ? 220 : 130);
      y += serviceStep;
    }
    y += 4;

    const focused = ctx.stack.isFocused();
    const actions = ["Allow", "Deny"];
    for (let index = 0; index < actions.length; index++) {
      const rowY = y + index * actionRowH;
      const selected = index === this.selectedIndex;
      if (selected) {
        drawSelectionHighlight(image, DIALOG_X + 12, rowY, DIALOG_WIDTH - 24, actionRowH - 1, focused, 8);
      }
      image.drawText(font, DIALOG_X + 22, rowY + 3, actions[index]!, selected ? 255 : 200);
    }
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-up":
      case "scroll-down":
        this.selectedIndex = (this.selectedIndex + 1) % 2;
        return;
      case "click":
        this.resolve(ctx, this.selectedIndex === 0);
        return;
      case "double-click":
        this.resolve(ctx, false);
        return;
      default:
        return;
    }
  }

  onRemoved(): void {
    // Dismissed some other way (window closed): treat as deny.
    if (!this.resolved) {
      this.resolved = true;
      this.onCancel();
    }
  }

  private resolve(ctx: LayerContext, allowed: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    ctx.stack.pop();
    if (allowed) this.onConfirm();
    else this.onCancel();
  }
}
