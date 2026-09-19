import { G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { type BdfFont } from "../../graphics/bdffont";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GESTURE_DOUBLE_CLICK, type InputEvent } from "../gestures";
import { drawSelectionHighlight } from "../menu";
import { listRowHeight } from "../metrics";
import { Layer, type LayerActions, type LayerContext } from "../layers";
import { wrapText, truncateText } from "../../graphics/textwrap";
import { MIN_WINDOW_HEIGHT, minWindowTop } from "./geometry";

const DIALOG_X = 40;
const DIALOG_W = G2_LENS_WIDTH - 80;
// The dialog fits inside the min-height window band (like the other shell
// overlays), wherever the vertical position setting puts it.
const DIALOG_MARGIN_Y = 24;
const DIALOG_H = MIN_WINDOW_HEIGHT - 2 * DIALOG_MARGIN_Y;
const TEXT_MAX_WIDTH = DIALOG_W - 32;
const MENU_ROWS = 2;

/** Dialog top edge; band-relative, so computed per paint. */
function dialogY(): number {
  return minWindowTop() + DIALOG_MARGIN_Y;
}

/** thinking: turn running; done/error: finished, showing the Follow-up/Done menu. */
type AssistantPhase = "thinking" | "done" | "error";

export type AssistantLayerCallbacks = {
  /** Record another utterance and continue this conversation. */
  onFollowUp: () => void;
  /** Abort the in-flight turn (double-click while thinking). */
  onCancel: () => void;
  /** The user closed the overlay (Done). */
  onClose: () => void;
  /** The layer left the stack by any path (Done, or the screen sleeping). */
  onRemoved?: () => void;
};

/**
 * The assistant overlay: streamed reply text with a status line for tool
 * activity, and a Follow-up / Done menu once the turn ends. Double-click
 * cancels an in-flight turn. The shell owns the AssistantSession and drives
 * this layer's state through the on* methods as the turn streams.
 */
export class AssistantLayer implements Layer {
  private phase: AssistantPhase = "thinking";
  private replyText = "";
  private status = "Thinking...";
  private menuIndex = 0;

  constructor(
    private readonly actions: LayerActions,
    private readonly callbacks: AssistantLayerCallbacks,
  ) {}

  /** Shell: a new turn (initial utterance or follow-up) is starting. */
  startTurn(): void {
    this.phase = "thinking";
    this.replyText = "";
    this.status = "Thinking...";
    this.menuIndex = 0;
    this.actions.requestRender();
  }

  onTextDelta(_delta: string, textSoFar: string): void {
    this.replyText = textSoFar;
    if (this.phase === "thinking") this.status = "Thinking...";
    this.actions.requestRender();
  }

  onToolActivity(label: string): void {
    if (this.phase === "thinking") this.status = `→ ${label}`;
    this.actions.requestRender();
  }

  onTurnDone(): void {
    this.phase = "done";
    this.status = this.replyText.trim() ? "" : "(no reply)";
    this.menuIndex = 0;
    this.actions.requestRender();
  }

  onError(message: string): void {
    this.phase = "error";
    this.status = message;
    this.menuIndex = 0;
    this.actions.requestRender();
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const font = getDefaultSmallFont();
    const menuRowH = listRowHeight(font);
    const image = paintBelow();
    const top = dialogY();

    // Solid dialog box (fill 1, matching the voice dialog: opaque after 4bpp
    // quantization, but not the color-key transparent 0).
    image.fillRoundedRect(DIALOG_X, top, DIALOG_W, DIALOG_H, 1, 10);
    image.drawRoundedRect(DIALOG_X, top, DIALOG_W, DIALOG_H, 90, 10);

    const left = DIALOG_X + 16;
    image.drawText(font, left, top + 12, this.phase === "thinking" ? "Assistant ●" : "Assistant", 220);
    if (this.status) {
      const statusValue = this.phase === "error" ? 200 : 130;
      image.drawText(font, left, top + 30, truncateText(font, this.status, TEXT_MAX_WIDTH), statusValue);
    }

    const inMenu = this.phase !== "thinking";
    const textBottom = inMenu ? top + DIALOG_H - MENU_ROWS * menuRowH - 8 : top + DIALOG_H - 8;
    const textTop = top + 56;
    const maxLines = Math.max(1, ((textBottom - textTop) / 16) | 0);

    const wrapped = wrapText(font, this.replyText, TEXT_MAX_WIDTH);
    // Keep the tail visible as text streams past the bottom.
    const firstLine = Math.max(0, wrapped.length - maxLines);
    for (let index = firstLine; index < wrapped.length; index++) {
      image.drawText(font, left, textTop + (index - firstLine) * 16, wrapped[index]!, 235);
    }

    if (inMenu) {
      const rows = ["Follow-up", "Done"];
      const menuTop = top + DIALOG_H - MENU_ROWS * menuRowH - 2;
      for (let i = 0; i < rows.length; i++) {
        const rowY = menuTop + i * menuRowH;
        const selected = i === this.menuIndex;
        if (selected) {
          drawSelectionHighlight(image, left - 4, rowY - 2, DIALOG_W - 24, menuRowH - 2, true, 6);
        }
        image.drawText(font, left + 4, rowY + 2, rows[i]!, selected ? 255 : 200);
      }
    } else {
      image.drawText(font, left, top + DIALOG_H - 14, `${GESTURE_DOUBLE_CLICK} cancel`, 110 - font.lineHeight);
    }
    return image;
  }

  handleInput(event: InputEvent, _ctx: LayerContext): void {
    if (this.phase === "thinking") {
      if (event.type === "double-click") {
        this.callbacks.onCancel();
        this.phase = "done";
        this.status = "Cancelled";
        this.menuIndex = 0;
        this.actions.requestRender();
      }
      return;
    }
    // done / error: the Follow-up / Done menu.
    switch (event.type) {
      case "scroll-up":
        this.menuIndex = (this.menuIndex + MENU_ROWS - 1) % MENU_ROWS;
        this.actions.requestRender();
        return;
      case "scroll-down":
        this.menuIndex = (this.menuIndex + 1) % MENU_ROWS;
        this.actions.requestRender();
        return;
      case "click":
        if (this.menuIndex === 0) {
          this.callbacks.onFollowUp();
        } else {
          this.callbacks.onClose();
        }
        return;
      case "double-click":
        this.callbacks.onClose();
        return;
      default:
        return;
    }
  }

  onRemoved(): void {
    this.callbacks.onRemoved?.();
  }
}
