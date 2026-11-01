import { type GrayImage } from "../../graphics/image";
import { type InputEvent } from "../gestures";
import { Layer, type LayerActions, type LayerContext } from "../layers";
import { type Menu } from "../menu-core";
import { createInputDialogMenu, paintInputDialog, type InputDialogRow } from "./input-dialog";
import { type VoiceSendTarget } from "./voice-input";

/** A menu row: a send target, or Discard (no target). */
type KeyboardMenuRow = InputDialogRow & { target?: VoiceSendTarget };

/**
 * Where the keyboard dialog shows: on both ends, only the phone's typing panel
 * (the glasses carry on as if no dialog were open), or only the glasses (the
 * phone hides its copy of the text but keeps the IME typing into it).
 */
export type KeyboardInputVisibility = "both" | "phone" | "glasses";

/** Sent messages kept for the phone's history button. */
const MAX_HISTORY = 20;

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
  readonly visibility: KeyboardInputVisibility;
  setVisibility(visibility: KeyboardInputVisibility): void;
  /** Messages sent from keyboard dialogs since the app started, newest first. */
  readonly history: ReadonlyArray<string>;
};

export type KeyboardInputLayerOptions = {
  actions: LayerActions;
  /** Post-removal cleanup (also fires when the screen turns off). */
  onClosed: () => void;
  /** Pop this layer off the shell stack. */
  dismiss: () => void;
  /**
   * Put the layer back on the shell stack, or take it off without ending the
   * session (phone-only visibility; onRemoved is ignored while hiding).
   */
  setShownOnGlasses: (shown: boolean) => void;
  /** Starting visibility; the shell pushes the layer only if it isn't "phone". */
  visibility: KeyboardInputVisibility;
  onVisibilityChanged: (visibility: KeyboardInputVisibility) => void;
  /** Shared, newest-first list this layer adds its sent message to. */
  history: string[];
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
  private readonly menu: Menu<KeyboardMenuRow>;
  private closed = false;
  private currentVisibility: KeyboardInputVisibility;
  // Set while the shell takes the layer off the stack for phone-only typing.
  private hiding = false;

  private readonly actions: LayerActions;
  private readonly onClosed: () => void;
  private readonly dismiss: () => void;
  private readonly setShownOnGlasses: (shown: boolean) => void;
  private readonly onVisibilityChanged: (visibility: KeyboardInputVisibility) => void;
  private readonly sentHistory: string[];
  private readonly sendTargets: VoiceSendTarget[];
  private readonly defaultTargetIndex: number;

  constructor(options: KeyboardInputLayerOptions) {
    this.actions = options.actions;
    this.onClosed = options.onClosed;
    this.dismiss = options.dismiss;
    this.setShownOnGlasses = options.setShownOnGlasses;
    this.currentVisibility = options.visibility;
    this.onVisibilityChanged = options.onVisibilityChanged;
    this.sentHistory = options.history;
    this.sendTargets = options.sendTargets;
    const defaultIndex = options.defaultTargetIndex ?? 0;
    this.defaultTargetIndex = Math.min(Math.max(0, defaultIndex), Math.max(0, this.sendTargets.length - 1));
    this.menu = createInputDialogMenu(this.menuRows(), this.defaultTargetIndex);
  }

  get targets(): ReadonlyArray<{ id: string; label: string }> {
    return this.sendTargets.map((target) => ({ id: target.id, label: target.label }));
  }

  get visibility(): KeyboardInputVisibility {
    return this.currentVisibility;
  }

  get history(): ReadonlyArray<string> {
    return this.sentHistory;
  }

  /** Whether the dialog is on the glasses (the shell stack) rather than phone-only. */
  get shownOnGlasses(): boolean {
    return this.currentVisibility !== "phone";
  }

  setVisibility(visibility: KeyboardInputVisibility): void {
    if (this.closed || visibility === this.currentVisibility) return;
    const wasShown = this.shownOnGlasses;
    this.currentVisibility = visibility;
    this.onVisibilityChanged(visibility);
    if (this.shownOnGlasses === wasShown) return;
    this.hiding = !this.shownOnGlasses;
    try {
      this.setShownOnGlasses(this.shownOnGlasses);
    } finally {
      this.hiding = false;
    }
  }

  setText(text: string): void {
    if (this.closed || this.text === text) return;
    this.text = text;
    this.actions.requestRender();
  }

  send(): void {
    const target = this.menu.selectedItem?.target ?? this.sendTargets[this.defaultTargetIndex];
    if (target) this.sendToTarget(target);
  }

  sendTo(targetId: string): void {
    const target = this.sendTargets.find((candidate) => candidate.id === targetId);
    if (target) this.sendToTarget(target);
  }

  discard(): void {
    this.close();
  }

  private close(): void {
    if (this.closed) return;
    // Phone-only, there is no stack entry to pop; end the session directly.
    if (this.shownOnGlasses) {
      this.dismiss();
    } else {
      this.finish();
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClosed();
  }

  private sendToTarget(target: VoiceSendTarget): void {
    if (this.closed) return;
    const text = this.text.trim();
    // An empty message has nothing to deliver; the dialog stays up for the
    // phone to keep typing (the glasses row is drawn dim for the same reason).
    if (!text) return;
    const previous = this.sentHistory.indexOf(text);
    if (previous >= 0) this.sentHistory.splice(previous, 1);
    this.sentHistory.unshift(text);
    this.sentHistory.length = Math.min(this.sentHistory.length, MAX_HISTORY);
    this.close();
    target.onSend(text);
  }

  /** The menu rows: one per send target, then Discard. */
  private menuRows(): KeyboardMenuRow[] {
    const hasText = this.text.trim().length > 0;
    const rows: KeyboardMenuRow[] = [];
    for (const target of this.sendTargets) {
      rows.push({ label: target.label, dim: !hasText, target });
    }
    rows.push({ label: "Discard", dim: false });
    return rows;
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = paintBelow();
    this.menu.setItems(this.menuRows());
    paintInputDialog(image, {
      title: "Keyboard",
      status: "Type on the phone",
      text: this.text || "(nothing typed yet)",
      menu: this.menu,
    });
    return image;
  }

  handleInput(event: InputEvent, _ctx: LayerContext): void {
    this.menu.setItems(this.menuRows());
    switch (event.type) {
      case "scroll-up":
      case "scroll-down":
        void this.menu.handleInput(event);
        this.actions.requestRender();
        return;
      case "click": {
        const row = this.menu.selectedItem;
        if (!row) return;
        if (row.target) {
          this.sendToTarget(row.target);
        } else {
          this.close();
        }
        return;
      }
      case "double-click":
        this.close();
        return;
      default:
        return;
    }
  }

  onRemoved(): void {
    // Taken off the glasses for phone-only typing: the session carries on.
    if (this.hiding) return;
    this.finish();
  }
}
