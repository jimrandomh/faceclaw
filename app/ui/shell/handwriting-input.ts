import { type GrayImage } from "../../graphics/image";
import { type InputEvent } from "../gestures";
import { Layer, type LayerActions, type LayerContext } from "../layers";
import { type Menu } from "../menu-core";
import { createInputDialogMenu, paintInputDialog, type InputDialogRow } from "./input-dialog";
import { type VoiceSendTarget } from "./voice-input";

/** Where a handwriting source is: switching its recognizer on, recognizing, or done (with why). */
export type HandwritingPhase = "starting" | "ready" | "stopped";

export type HandwritingListener = {
  /** The whole message as recognized so far (it can shrink: the writer erased). */
  text(text: string): void;
  phase(phase: HandwritingPhase, message: string): void;
};

/**
 * Something that recognizes handwriting (today the Meta Neural Band; see
 * app/g2/neural-band.ts). The dialog starts it when it opens and stops it when
 * it closes, so a recognizer that costs power runs only while text is wanted.
 */
export type HandwritingSource = {
  /** What the dialog calls the device ("Neural Band"). */
  readonly name: string;
  /** Start recognizing into `listener`. Returns why it can't, or null. */
  start(listener: HandwritingListener): string | null;
  /** Replace the recognized text (the dialog's own edits), so later writing continues from it. */
  setText(text: string): void;
  stop(): void;
};

type HandwritingMenuRow = InputDialogRow & { target?: VoiceSendTarget };

export type HandwritingInputLayerOptions = {
  actions: LayerActions;
  source: HandwritingSource;
  /** Post-removal cleanup (also fires when the screen turns off). */
  onClosed: () => void;
  /** Pop this layer off the shell stack (its onRemoved then ends the session). */
  dismiss: () => void;
  /** Ordered send destinations shown as the first menu rows. */
  sendTargets: VoiceSendTarget[];
  defaultTargetIndex?: number;
};

/**
 * The voice dialog's handwritten twin: the same box on the glasses, with the
 * message written in the air with a finger and recognized by the source. The
 * text grows as it is recognized; the menu sends it where the voice and
 * keyboard dialogs would.
 *
 * Swipes edit rather than navigate (the band writes with the index finger and
 * swipes with the thumb): left erases a character, right types a space, up and
 * down move through the menu. A tap picks the highlighted row; a double tap
 * discards, as in the other dialogs.
 */
export class HandwritingInputLayer implements Layer {
  readonly acceptsDirectional = true;
  private text = "";
  private phase: HandwritingPhase = "starting";
  private status = "";
  private readonly menu: Menu<HandwritingMenuRow>;
  private closed = false;
  private readonly actions: LayerActions;
  private readonly source: HandwritingSource;
  private readonly onClosed: () => void;
  private readonly dismiss: () => void;
  private readonly sendTargets: VoiceSendTarget[];

  constructor(options: HandwritingInputLayerOptions) {
    this.actions = options.actions;
    this.source = options.source;
    this.onClosed = options.onClosed;
    this.dismiss = options.dismiss;
    this.sendTargets = options.sendTargets;
    const defaultIndex = Math.min(Math.max(0, options.defaultTargetIndex ?? 0), Math.max(0, this.sendTargets.length - 1));
    this.menu = createInputDialogMenu(this.menuRows(), defaultIndex);
    this.status = `Starting the ${this.source.name}'s handwriting…`;
    const problem = this.source.start({
      text: (text) => {
        if (this.closed || text === this.text) return;
        this.text = text;
        this.actions.requestRender();
      },
      phase: (phase, message) => {
        if (this.closed) return;
        this.phase = phase;
        this.status = phase === "ready" ? "Write with your index finger" : message;
        this.actions.requestRender();
      },
    });
    if (problem) {
      this.phase = "stopped";
      this.status = problem;
    }
  }

  /** The text the menu would send: the recognized message, trimmed. */
  get message(): string {
    return this.text.trim();
  }

  private setText(text: string): void {
    if (this.closed || text === this.text) return;
    this.text = text;
    this.source.setText(text);
    this.actions.requestRender();
  }

  private menuRows(): HandwritingMenuRow[] {
    const hasText = this.message.length > 0;
    const rows: HandwritingMenuRow[] = this.sendTargets.map((target) => ({ label: target.label, dim: !hasText, target }));
    rows.push({ label: "Discard", dim: false });
    return rows;
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const image = paintBelow();
    this.menu.setItems(this.menuRows());
    paintInputDialog(image, {
      title: "Handwriting",
      status: this.status,
      statusValue: this.phase === "stopped" ? 200 : undefined,
      text: this.text || (this.phase === "ready" ? "(write letters in the air or on a surface)" : ""),
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
      case "swipe-up":
      case "swipe-down":
        void this.menu.handleInput({ ...event, type: event.type === "swipe-up" ? "scroll-up" : "scroll-down" });
        this.actions.requestRender();
        return;
      case "swipe-left":
        this.setText(dropLastCharacter(this.text));
        return;
      case "swipe-right":
        if (this.text && !this.text.endsWith(" ")) this.setText(`${this.text} `);
        return;
      case "click": {
        const row = this.menu.selectedItem;
        if (!row) return;
        if (row.target) this.sendToTarget(row.target);
        else this.close();
        return;
      }
      case "double-click":
        this.close();
        return;
      default:
        return;
    }
  }

  private sendToTarget(target: VoiceSendTarget): void {
    const text = this.message;
    // Nothing written yet: the dialog stays up (the row is drawn dim for the same reason).
    if (this.closed || !text) return;
    this.close();
    target.onSend(text);
  }

  private close(): void {
    if (this.closed) return;
    this.dismiss();
    // onRemoved normally ends the session; make sure it ends even if the layer was already off the stack.
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.source.stop();
    this.onClosed();
  }

  onRemoved(): void {
    this.finish();
  }
}

/** Drop the last user-perceived character (a whole emoji or accented letter, not half of one). */
export function dropLastCharacter(text: string): string {
  if (!text) return text;
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment(text: string): Iterable<{ index: number }> } }).Segmenter;
  if (Segmenter) {
    let last = 0;
    for (const segment of new Segmenter(undefined, { granularity: "grapheme" }).segment(text)) last = segment.index;
    return text.slice(0, last);
  }
  return Array.from(text).slice(0, -1).join("");
}
