import { G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { wrapText, truncateText } from "../../graphics/textwrap";
import { type BdfFont } from "../../graphics/bdffont";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import { refineDictation, type AnthropicStreamHandle } from "../../native/anthropic";
import { anthropicApiKeySetting } from "../dashboard-settings";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, gestureHints, type InputEvent } from "../gestures";
import { drawSelectionHighlight } from "../menu";
import { listRowHeight } from "../metrics";
import { Layer, type LayerActions, type LayerContext } from "../layers";
import { MIN_WINDOW_HEIGHT, minWindowTop } from "./geometry";

const DIALOG_X = 40;
const DIALOG_W = G2_LENS_WIDTH - 80;
// The dialog fits inside the min-height window band (like the other shell
// overlays), wherever the vertical position setting puts it.
const DIALOG_MARGIN_Y = 24;
const DIALOG_H = MIN_WINDOW_HEIGHT - 2 * DIALOG_MARGIN_Y;
const TEXT_MAX_WIDTH = DIALOG_W - 32;

/** Dialog top edge; band-relative, so computed per paint. */
function dialogY(): number {
  return minWindowTop() + DIALOG_MARGIN_Y;
}
// After the mic stops, the provider's final transcript can trail in (cloud
// commit round-trip); wait this long for it before refining with what we have.
const FOLLOWUP_FINALIZE_TIMEOUT_MS = 1200;

/**
 * The dialog's lifecycle. "capturing" is the first utterance (push-to-talk or
 * click-to-finish); "menu" is the send / Continue / Discard menu; "continuing"
 * records a follow-up utterance (always click-to-finish); "refining" streams
 * the LLM-merged text, then returns to "menu".
 */
type VoicePhase = "capturing" | "menu" | "continuing" | "refining";

/**
 * A destination the captured text can be sent to. The shell supplies these per
 * entry point: "Send to Assistant" (hand off to the voice assistant) and/or
 * "Type Into App" (deliver to the foreground window's text input).
 */
export type VoiceSendTarget = {
  id: string;
  label: string;
  onSend: (text: string) => void;
};

export type VoiceInputLayerOptions = {
  actions: LayerActions;
  /** Post-removal cleanup (also fires when the screen turns off). */
  onClosed: () => void;
  /** Pop this layer off the shell stack. */
  dismiss: () => void;
  /** Ordered send destinations shown as the first menu rows. */
  sendTargets: VoiceSendTarget[];
  /** Which send target is highlighted by default (entry-point dependent). */
  defaultTargetIndex?: number;
  /** A single click ends the utterance (opened from a menu, no held button). */
  finishOnClick?: boolean;
  /** Wakeword flow: mic starts immediately and ends on detected silence. */
  handsFree?: boolean;
  /** Skip the menu: on capture end, send straight to the default target. */
  autoSend?: boolean;
};

/**
 * Push-to-talk voice dialog, drawn on top of whatever is already on screen.
 * The mic runs while the button is held (long-press); releasing it stops the
 * mic and shows a Send / Continue / Discard menu. Send delivers the transcript
 * to the foreground window (e.g. the terminal); Discard (or double-click)
 * closes. Continue records another utterance — extra content or a spoken edit
 * ("change X to Y", "insert ... after ...") — and merges it into the message
 * with an LLM, landing back on the same menu.
 *
 * When opened from a menu instead of a held button (finishOnClick), there is
 * no release event to end the capture, so a single click stops the mic.
 *
 * When opened by the "Hey Even" wakeword (handsFree), there is likewise no
 * button involved: the mic starts immediately and stops when the speaker does,
 * via endpoint detection on the decoded PCM. A click still ends it early.
 */
export class VoiceInputLayer implements Layer {
  private phase: VoicePhase = "capturing";
  private status = "Listening...";
  // The active utterance. displayText() is what the dialog shows and what
  // Send delivers; the refine flow also writes the merged result here.
  private finalizedText = "";
  private liveText = "";
  // Snapshot of the message when Continue starts, so a failed or cancelled
  // continuation can fall back to it.
  private baseText = "";
  /** Whether the mic is running (capture bookkeeping, not UI state). */
  private capturing = false;
  /** Continuation stopped; waiting for the trailing final transcript. */
  private followupFinalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private refineHandle: AnthropicStreamHandle | null = null;
  private menuIndex = 0;
  /** Auto-send (wakeword skip-confirmation) is waiting to fire. */
  private pendingAutoSend = false;
  private autoSendTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private unsubscribeSpeechEnd: (() => void) | null = null;

  private readonly actions: LayerActions;
  private readonly onClosed: () => void;
  private readonly dismiss: () => void;
  private readonly sendTargets: VoiceSendTarget[];
  private readonly defaultTargetIndex: number;
  private readonly finishOnClick: boolean;
  private readonly handsFree: boolean;
  private readonly autoSend: boolean;

  constructor(options: VoiceInputLayerOptions) {
    this.actions = options.actions;
    this.onClosed = options.onClosed;
    this.dismiss = options.dismiss;
    this.sendTargets = options.sendTargets;
    this.finishOnClick = options.finishOnClick ?? false;
    this.handsFree = options.handsFree ?? false;
    this.autoSend = options.autoSend ?? false;
    const defaultIndex = options.defaultTargetIndex ?? 0;
    this.defaultTargetIndex = Math.min(Math.max(0, defaultIndex), Math.max(0, this.sendTargets.length - 1));
    this.menuIndex = this.defaultTargetIndex;
  }

  startCapture(): void {
    if (this.capturing) return;
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => this.onTranscript(event));
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      // The refine stage owns the status line ("Refining...", error text).
      if (this.phase === "refining") return;
      this.status = state.status;
      this.actions.requestRender();
    });
    if (this.handsFree) {
      // No button is held, so the mic has to stop itself. endCapture() is
      // idempotent, and a click still ends the utterance early.
      this.unsubscribeSpeechEnd = voiceControlBridge.onSpeechEnd(() => {
        if (this.phase === "capturing") {
          this.endCapture();
        }
      });
    }
    this.capturing = true;
    void this.actions.startVoiceCapture(this.handsFree);
    this.actions.requestRender();
  }

  /**
   * Whether a single click ends the utterance. True when there is no held
   * button to release: opened from the overlay menu (finishOnClick), or
   * hands-free from the wakeword — where it also lets the user cut the
   * silence-detection wait short.
   */
  private get clickEndsCapture(): boolean {
    return this.finishOnClick || this.handsFree;
  }

  /** Button released (or click when clickEndsCapture): stop the mic. */
  endCapture(): void {
    if (!this.capturing) return;
    if (this.phase === "continuing") {
      this.endContinuationCapture();
      return;
    }
    this.capturing = false;
    this.phase = "menu";
    void this.actions.stopVoiceCapture();
    if (this.autoSend && this.sendTargets.length) {
      // Skip-confirmation (wakeword): send to the default target as soon as the
      // transcript finalizes, or after a short wait for the trailing final.
      this.pendingAutoSend = true;
      this.status = "Sending...";
      this.autoSendTimer = setTimeout(() => this.performAutoSend(), FOLLOWUP_FINALIZE_TIMEOUT_MS);
    } else if (this.status.startsWith("Listening")) {
      this.status = "Send, continue, or discard?";
    }
    this.actions.requestRender();
  }

  /** Fire the queued skip-confirmation send (or fall back to the menu). */
  private performAutoSend(): void {
    if (this.autoSendTimer !== null) {
      clearTimeout(this.autoSendTimer);
      this.autoSendTimer = null;
    }
    if (!this.pendingAutoSend) return;
    this.pendingAutoSend = false;
    const text = this.displayText().trim();
    const target = this.sendTargets[this.defaultTargetIndex];
    if (text && target) {
      this.dismiss();
      target.onSend(text);
    } else {
      // Nothing heard; fall back to the menu so the user can retry or discard.
      this.status = "Send, continue, or discard?";
      this.actions.requestRender();
    }
  }

  /** The menu rows: one per send target, then Continue, then Discard. */
  private menuRows(): Array<{ label: string; dim: boolean; onSelect: () => void }> {
    const text = this.displayText().trim();
    const hasText = text.length > 0;
    const hasLlmKey = anthropicApiKeySetting.get().trim().length > 0;
    const rows: Array<{ label: string; dim: boolean; onSelect: () => void }> = [];
    for (const target of this.sendTargets) {
      rows.push({
        label: target.label,
        dim: !hasText,
        onSelect: () => {
          this.dismiss();
          if (hasText) target.onSend(text);
        },
      });
    }
    rows.push({
      label: hasLlmKey ? "Continue" : "Continue (Needs LLM API key)",
      dim: !hasLlmKey,
      onSelect: () => {
        if (hasLlmKey) this.startContinuation();
      },
    });
    rows.push({ label: "Discard", dim: false, onSelect: () => this.dismiss() });
    return rows;
  }

  paint(_ctx: LayerContext, paintBelow: () => GrayImage): GrayImage {
    const font = getDefaultSmallFont();
    const menuRowH = listRowHeight(font);
    const image = paintBelow();
    const top = dialogY();

    // Solid dialog box over the underlying UI. Fill 1, not 0: identical after
    // 4bpp quantization, but 0 is transparent on the color-key shell surface.
    image.fillRoundedRect(DIALOG_X, top, DIALOG_W, DIALOG_H, 1, 10);
    image.drawRoundedRect(DIALOG_X, top, DIALOG_W, DIALOG_H, 90, 10);

    const left = DIALOG_X + 16;
    image.drawText(font, left, top + 12, this.capturing ? "Voice ●" : "Voice", 220);
    image.drawText(font, left, top + 30, truncateText(font, this.status, TEXT_MAX_WIDTH), 130);

    const inMenu = this.phase === "menu";
    const rows = inMenu ? this.menuRows() : [];
    // Reserve space for the actual number of rows this menu has.
    const textBottom = inMenu ? top + DIALOG_H - rows.length * menuRowH - 8 : top + DIALOG_H - 8;
    const textTop = top + 56;
    const maxLines = Math.max(1, ((textBottom - textTop) / 16) | 0);

    const text = this.displayText() || this.placeholderText();
    const wrapped = wrapText(font, text, TEXT_MAX_WIDTH);
    const firstLine = Math.max(0, wrapped.length - maxLines);
    for (let index = firstLine; index < wrapped.length; index++) {
      image.drawText(font, left, textTop + (index - firstLine) * 16, wrapped[index]!, 235);
    }

    if (inMenu) {
      const menuTop = top + DIALOG_H - rows.length * menuRowH - 2;
      for (let i = 0; i < rows.length; i++) {
        const rowY = menuTop + i * menuRowH;
        const selected = i === this.menuIndex;
        if (selected) {
          drawSelectionHighlight(image, left - 4, rowY - 2, DIALOG_W - 24, menuRowH - 2, true, 6);
        }
        const row = rows[i]!;
        image.drawText(font, left + 4, rowY + 2, row.label, row.dim ? 90 : selected ? 255 : 200);
      }
    } else {
      image.drawText(font, left, top + DIALOG_H - 14, this.hintText(), 110-font.lineHeight);
    }
    return image;
  }

  handleInput(event: InputEvent, _ctx: LayerContext): void {
    switch (this.phase) {
      case "capturing":
        if (event.type === "double-click") {
          this.dismiss();
        } else if (this.clickEndsCapture && event.type === "click") {
          this.endCapture();
        }
        return;
      case "continuing":
        if (event.type === "click") {
          this.endContinuationCapture();
        } else if (event.type === "double-click") {
          this.cancelContinuation("Continuation cancelled");
        }
        return;
      case "refining":
        if (event.type === "double-click") {
          this.cancelContinuation("Refinement cancelled");
        }
        return;
      case "menu":
        this.handleMenuInput(event);
        return;
    }
  }

  private handleMenuInput(event: InputEvent): void {
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
        row?.onSelect();
        return;
      }
      case "double-click":
        this.dismiss();
        return;
      default:
        return;
    }
  }

  /** Continue selected: keep the message aside and record a follow-up. */
  private startContinuation(): void {
    this.baseText = this.displayText().trim();
    this.finalizedText = "";
    this.liveText = "";
    this.phase = "continuing";
    this.status = "Listening...";
    this.capturing = true;
    void this.actions.startVoiceCapture();
    this.actions.requestRender();
  }

  /** Follow-up tap: stop the mic, then refine once the transcript finalizes. */
  private endContinuationCapture(): void {
    if (!this.capturing) return;
    this.capturing = false;
    void this.actions.stopVoiceCapture();
    this.status = "Refining...";
    this.actions.requestRender();
    // The provider's committed transcript arrives shortly after stop; refine
    // when it does, or after a timeout with whatever partials we have.
    this.followupFinalizeTimer = setTimeout(() => this.beginRefine(), FOLLOWUP_FINALIZE_TIMEOUT_MS);
  }

  private beginRefine(): void {
    if (this.followupFinalizeTimer !== null) {
      clearTimeout(this.followupFinalizeTimer);
      this.followupFinalizeTimer = null;
    }
    if (this.phase !== "continuing") return;
    const followup = this.displayText().trim();
    if (!followup) {
      this.backToMenu(this.baseText, "No follow-up heard");
      return;
    }
    this.phase = "refining";
    this.finalizedText = "";
    this.liveText = "";
    this.status = "Refining...";
    this.actions.requestRender();
    this.refineHandle = refineDictation({
      apiKey: anthropicApiKeySetting.get(),
      original: this.baseText,
      followup,
      onTextDelta: (_delta, textSoFar) => {
        this.finalizedText = textSoFar;
        this.actions.requestRender();
      },
      onDone: (text) => {
        this.refineHandle = null;
        this.backToMenu(text, "Send, continue, or discard?");
      },
      onError: (message) => {
        this.refineHandle = null;
        this.backToMenu(this.baseText, message);
      },
    });
  }

  /** Abort a continuation (mic or LLM stage) and restore the prior message. */
  private cancelContinuation(status: string): void {
    if (this.capturing) {
      this.capturing = false;
      void this.actions.stopVoiceCapture();
    }
    this.refineHandle?.cancel();
    this.refineHandle = null;
    this.backToMenu(this.baseText, status);
  }

  private backToMenu(text: string, status: string): void {
    if (this.followupFinalizeTimer !== null) {
      clearTimeout(this.followupFinalizeTimer);
      this.followupFinalizeTimer = null;
    }
    this.finalizedText = text;
    this.liveText = "";
    this.phase = "menu";
    this.menuIndex = 0;
    this.status = status;
    this.actions.requestRender();
  }

  onRemoved(): void {
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    this.unsubscribeSpeechEnd?.();
    this.unsubscribeSpeechEnd = null;
    if (this.followupFinalizeTimer !== null) {
      clearTimeout(this.followupFinalizeTimer);
      this.followupFinalizeTimer = null;
    }
    if (this.autoSendTimer !== null) {
      clearTimeout(this.autoSendTimer);
      this.autoSendTimer = null;
    }
    this.pendingAutoSend = false;
    this.refineHandle?.cancel();
    this.refineHandle = null;
    if (this.capturing) {
      this.capturing = false;
      void this.actions.stopVoiceCapture();
    }
    this.onClosed();
  }

  private displayText(): string {
    if (!this.finalizedText) return this.liveText;
    if (!this.liveText) return this.finalizedText;
    return `${this.finalizedText} ${this.liveText}`;
  }

  private placeholderText(): string {
    switch (this.phase) {
      case "capturing":
        return "Listening...";
      case "continuing":
        return "Say more, or describe an edit...";
      case "refining":
        return "Refining...";
      case "menu":
        return "(no speech detected)";
    }
  }

  private hintText(): string {
    switch (this.phase) {
      case "capturing":
        return this.clickEndsCapture
          ? gestureHints([[GESTURE_CLICK, "done"], [GESTURE_DOUBLE_CLICK, "close"]])
          : `${GESTURE_DOUBLE_CLICK} close`;
      case "continuing":
        return gestureHints([[GESTURE_CLICK, "done"], [GESTURE_DOUBLE_CLICK, "cancel"]]);
      case "refining":
      default:
        return `${GESTURE_DOUBLE_CLICK} cancel`;
    }
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    // The refine stream owns the text buffers once it starts; a transcript
    // that trails in after that point is stale.
    if (this.phase === "refining") return;
    if (event.isFinal) {
      const finalText = event.text.trim() || this.liveText.trim();
      if (finalText) {
        this.finalizedText = this.finalizedText ? `${this.finalizedText} ${finalText}` : finalText;
      }
      this.liveText = "";
      if (this.phase === "continuing" && this.followupFinalizeTimer !== null) {
        // The follow-up finalized; no need to keep waiting.
        this.beginRefine();
        return;
      }
      if (this.pendingAutoSend) {
        // The utterance finalized; skip-confirmation can fire without waiting
        // out the fallback timer.
        this.performAutoSend();
        return;
      }
    } else {
      this.liveText = event.text.trim();
    }
    this.actions.requestRender();
  }
}
