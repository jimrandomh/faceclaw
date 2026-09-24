import { type GrayImage } from "../../graphics/image";
import { GESTURE_DOUBLE_CLICK, type InputEvent } from "../gestures";
import { Layer, type LayerActions, type LayerContext } from "../layers";
import { createInputDialogMenu, paintInputDialog, type InputDialogRow } from "./input-dialog";

const FOLLOW_UP_ROW = 0;
const MENU_ROWS: readonly InputDialogRow[] = [
  { label: "Follow-up", dim: false },
  { label: "Done", dim: false },
];

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
  private readonly menu = createInputDialogMenu(MENU_ROWS);

  constructor(
    private readonly actions: LayerActions,
    private readonly callbacks: AssistantLayerCallbacks,
  ) {}

  /** Shell: a new turn (initial utterance or follow-up) is starting. */
  startTurn(): void {
    this.phase = "thinking";
    this.replyText = "";
    this.status = "Thinking...";
    this.menu.select(0);
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
    this.menu.select(0);
    this.actions.requestRender();
  }

  onError(message: string): void {
    this.phase = "error";
    this.status = message;
    this.menu.select(0);
    this.actions.requestRender();
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = paintBelow();
    const inMenu = this.phase !== "thinking";
    paintInputDialog(image, {
      title: this.phase === "thinking" ? "Assistant ●" : "Assistant",
      status: this.status,
      statusValue: this.phase === "error" ? 200 : 130,
      text: this.replyText,
      menu: inMenu ? this.menu : null,
      hint: inMenu ? undefined : `${GESTURE_DOUBLE_CLICK} cancel`,
    });
    return image;
  }

  handleInput(event: InputEvent, _ctx: LayerContext): void {
    if (this.phase === "thinking") {
      if (event.type === "double-click") {
        this.callbacks.onCancel();
        this.phase = "done";
        this.status = "Cancelled";
        this.menu.select(0);
        this.actions.requestRender();
      }
      return;
    }
    // done / error: the Follow-up / Done menu.
    switch (event.type) {
      case "scroll-up":
      case "scroll-down":
        void this.menu.handleInput(event);
        this.actions.requestRender();
        return;
      case "click":
        if (this.menu.selectedIndex === FOLLOW_UP_ROW) {
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
