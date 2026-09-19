import { type GrayImage } from "../../graphics/image";
import { type InputEvent } from "../gestures";
import { Layer, type LayerActions, type LayerContext } from "../layers";
import { paintInputDialog } from "./input-dialog";
import { type VoiceSendTarget } from "./voice-input";

/**
 * The phone side's handle on an open keyboard-input dialog: the phone types
 * into it and picks where the text goes. The layer itself implements this;
 * the controller hands it to the phone UI while the dialog is up.
 */
export type KeyboardInputSession = {
  /** The send destinations, in the glasses menu's row order. */
  readonly targets: ReadonlyArray<{ id: string; label: string }>;
  /** Replace the message with what the phone's text field now holds. */
  setText(text: string): void;
  /**
   * Send to the destination highlighted on the glasses (the entry point's
   * default unless the user scrolled the menu). The IME's send key.
   */
  send(): void;
  sendTo(targetId: string): void;
  discard(): void;
};

export type KeyboardInputLayerOptions = {
  actions: LayerActions;
  /** Post-removal cleanup (also fires when the screen turns off). */
  onClosed: () => void;
  /** Pop this layer off the shell stack. */
  dismiss: () => void;
  /** Ordered send destinations shown as the first menu rows. */
  sendTargets: VoiceSendTarget[];
  /** Which send target is highlighted by default (entry-point dependent). */
  defaultTargetIndex?: number;
};

/**
 * The voice dialog's keyboard twin: the same box on the glasses, but the
 * message is typed on the phone (its IME, opened by the keyboard button next
 * to the mic button) instead of transcribed. The glasses mirror the text as
 * it is typed and show the same send / discard menu, which works from either
 * end: the ring or watch scrolls and clicks it, the phone has a button per
 * row plus the IME's send key. There is no Continue row — the phone can
 * simply edit the text.
 */
export class KeyboardInputLayer implements Layer, KeyboardInputSession {
  private text = "";
  private menuIndex: number;
  private closed = false;

  private readonly actions: LayerActions;
  private readonly onClosed: () => void;
  private readonly dismiss: () => void;
  private readonly sendTargets: VoiceSendTarget[];
  private readonly defaultTargetIndex: number;

  constructor(options: KeyboardInputLayerOptions) {
    this.actions = options.actions;
    this.onClosed = options.onClosed;
    this.dismiss = options.dismiss;
    this.sendTargets = options.sendTargets;
    const defaultIndex = options.defaultTargetIndex ?? 0;
    this.defaultTargetIndex = Math.min(Math.max(0, defaultIndex), Math.max(0, this.sendTargets.length - 1));
    this.menuIndex = this.defaultTargetIndex;
  }

  get targets(): ReadonlyArray<{ id: string; label: string }> {
    return this.sendTargets.map((target) => ({ id: target.id, label: target.label }));
  }

  setText(text: string): void {
    if (this.closed || this.text === text) return;
    this.text = text;
    this.actions.requestRender();
  }

  send(): void {
    const row = this.menuRows()[this.menuIndex];
    const target = row?.target ?? this.sendTargets[this.defaultTargetIndex];
    if (target) this.sendToTarget(target);
  }

  sendTo(targetId: string): void {
    const target = this.sendTargets.find((candidate) => candidate.id === targetId);
    if (target) this.sendToTarget(target);
  }

  discard(): void {
    if (!this.closed) this.dismiss();
  }

  private sendToTarget(target: VoiceSendTarget): void {
    if (this.closed) return;
    const text = this.text.trim();
    // An empty message has nothing to deliver; the dialog stays up for the
    // phone to keep typing (the glasses row is drawn dim for the same reason).
    if (!text) return;
    this.dismiss();
    target.onSend(text);
  }

  /** The menu rows: one per send target, then Discard. */
  private menuRows(): Array<{ label: string; dim: boolean; target?: VoiceSendTarget }> {
    const hasText = this.text.trim().length > 0;
    const rows: Array<{ label: string; dim: boolean; target?: VoiceSendTarget }> = [];
    for (const target of this.sendTargets) {
      rows.push({ label: target.label, dim: !hasText, target });
    }
    rows.push({ label: "Discard", dim: false });
    return rows;
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = paintBelow();
    paintInputDialog(image, {
      title: "Keyboard",
      status: "Type on the phone",
      text: this.text || "(nothing typed yet)",
      rows: this.menuRows(),
      selectedRow: this.menuIndex,
    });
    return image;
  }

  handleInput(event: InputEvent, _ctx: LayerContext): void {
    const rowCount = this.menuRows().length;
    switch (event.type) {
      case "scroll-up":
        this.menuIndex = (this.menuIndex + rowCount - 1) % rowCount;
        this.actions.requestRender();
        return;
      case "scroll-down":
        this.menuIndex = (this.menuIndex + 1) % rowCount;
        this.actions.requestRender();
        return;
      case "click": {
        const row = this.menuRows()[this.menuIndex];
        if (!row) return;
        if (row.target) {
          this.sendToTarget(row.target);
        } else {
          this.dismiss();
        }
        return;
      }
      case "double-click":
        this.dismiss();
        return;
      default:
        return;
    }
  }

  onRemoved(): void {
    this.closed = true;
    this.onClosed();
  }
}
