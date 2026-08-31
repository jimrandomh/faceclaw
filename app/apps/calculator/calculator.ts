// The calculator app layer for FaceClaw: a spoken (or typed) problem in, an
// exact answer on the lens.
//
// Deliberately thin. Everything mathematical belongs to math/ and everything
// about the standing problem, follow-ups, and long runs belongs to
// MathCoordinator. This layer owns only what is genuinely the app's: which
// mode a fresh capture lands in, what the viewport shows, and how the
// touchpad and the microphone are shared.

import { GrayImage, type UiFont } from "../../graphics/image";
import { getDefaultLargeFont, getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { wrapText, truncateText } from "../../graphics/textwrap";
import { lineStep } from "../../ui/metrics";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, gestureHints, type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerActions, type LayerContext } from "../../ui/layers";
import { ConfigSettingBoolean, ConfigSettingEnum } from "../../ui/dashboard-settings";
import { shell } from "../../ui/shell/shell";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import { type MathBranchOutcome, MathCoordinator } from "./math/coordinator";
import { type LongRunOffer, type LongRunProgress, offerGlassesPrompt, progressText } from "./math/workload";
import { plain } from "./math/text-renderer";
import { drawGraph } from "./calculator-graph";
import { type CalculatorListening, type CalculatorMode, CALCULATOR_MODES, cycleMode, isDictationCancellation, isWorthAnswering, listeningLabel, modeCommand, modeLabel } from "./calculator-commands";

// ---------------------------------------------------------------------------
// Settings

/** The mode a fresh capture lands in. Also what scrolling cycles. */
export const calculatorModeSetting = new ConfigSettingEnum<CalculatorMode>({
  id: "calculator-mode",
  label: "Default mode",
  storageKey: "calculator.defaultMode",
  defaultValue: "solve",
  values: [...CALCULATOR_MODES],
  formatValue: modeLabel,
  description:
    "What a freshly stated problem does. On the glasses, scroll applies another mode — or walks Explain steps — and tap toggles the mic.",
});

export const calculatorListeningSetting = new ConfigSettingEnum<CalculatorListening>({
  id: "calculator-listening",
  label: "Listening",
  storageKey: "calculator.listening",
  defaultValue: "tap",
  values: ["tap", "continuous"],
  formatValue: listeningLabel,
  description:
    "Tap to talk captures one problem per tap. Continuous listens the whole time the calculator is in front, answering anything that sounds like maths.",
});

export const calculatorDegreesSetting = new ConfigSettingBoolean({
  id: "calculator-degrees",
  label: "Trigonometry in degrees",
  storageKey: "calculator.usesDegrees",
  defaultValue: false,
  description: "Evaluate sin/cos/tan in degrees instead of radians.",
});

// ---------------------------------------------------------------------------
// Layer

export class CalculatorLayer implements Layer {
  /** Rebound by the window factory once the window exists. */
  requestRender: () => void = () => {};

  /**
   * The last thing said to the calculator, so the view can show what it
   * heard next to what it made of it — the only way a wearer can tell a
   * mis-heard problem from a wrong answer.
   */
  private lastInput = "";
  private lastAnswer = "";
  private lastFailure: string | null = null;
  private working = false;
  /** True while one finalized utterance is armed for capture. */
  private dictating = false;
  private foreground = true;
  private continuousActive = false;
  private unsubscribeTranscript: (() => void) | null = null;
  private lastDeepAnswer: MathBranchOutcome | null = null;

  constructor(
    private readonly coordinator: MathCoordinator,
    private readonly actions: LayerActions,
  ) {
    this.coordinator.setUsesDegrees(calculatorDegreesSetting.get());
    this.coordinator.onChanged = () => this.handleCoordinatorChanged();
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => this.onTranscript(event));
  }

  private get mode(): CalculatorMode {
    return calculatorModeSetting.get();
  }

  private get listening(): CalculatorListening {
    return calculatorListeningSetting.get();
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  onRemoved(): void {
    this.stopListening();
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.coordinator.onChanged = null;
  }

  /** Foreground/background transitions, forwarded by the window factory. */
  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    if (!foreground) {
      this.stopListening();
    } else {
      this.refreshListening();
    }
  }

  /** Apply a settings change: degrees and the listening mode both act immediately. */
  applySettings(): void {
    this.coordinator.setUsesDegrees(calculatorDegreesSetting.get());
    this.refreshListening();
    this.requestRender();
  }

  private refreshListening(): void {
    if (!this.foreground) return;
    if (this.listening === "continuous") {
      if (!this.continuousActive) {
        this.continuousActive = true;
        void this.actions.startContinuousVoiceCapture();
      }
    } else if (this.continuousActive) {
      this.continuousActive = false;
      void this.actions.stopContinuousVoiceCapture();
    }
  }

  private stopListening(): void {
    if (this.dictating) {
      this.dictating = false;
      void this.actions.stopVoiceCapture();
    }
    if (this.continuousActive) {
      this.continuousActive = false;
      void this.actions.stopContinuousVoiceCapture();
    }
  }

  // -------------------------------------------------------------------------
  // Asking

  /**
   * Put a problem (or a follow-up command) to the calculator.
   *
   * Command first, problem second. "graph it" contains no operator and would
   * fail as an expression, and a wearer who says it expects the plot of what
   * is already on the lens rather than an error about the word "it".
   */
  submit(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.lastInput = trimmed;
    this.lastFailure = null;

    const selected = modeCommand(trimmed);
    if (selected) {
      this.performFollowUp(selected);
      return;
    }

    const target = this.mode;
    this.working = true;
    this.requestRender();
    void this.coordinator.answerSpoken(trimmed).then((outcome) => {
      // A fresh problem lands in the app's mode: solving is the default, but
      // a wearer whose default is "graph" said the problem in order to see it
      // plotted, not to read its root.
      if (outcome.kind === "value" && target !== "solve") {
        outcome = this.coordinator.run(target, "");
      }
      this.working = false;
      this.applyOutcome(outcome);
    });
  }

  /**
   * Re-run the standing problem through a different presentation branch.
   * This is the one action used by scroll cycling, spoken "… it" commands,
   * and the window menu, so changing mode can never mean "change a setting
   * but leave the old answer up".
   */
  performFollowUp(selected: CalculatorMode): void {
    calculatorModeSetting.set(selected);
    if (!this.coordinator.hasProblem) {
      this.lastFailure = "No problem yet";
      this.requestRender();
      return;
    }
    this.working = false;
    this.lastFailure = null;
    this.applyOutcome(this.coordinator.run(selected, ""));
  }

  clear(): void {
    this.working = false;
    this.lastInput = "";
    this.lastAnswer = "";
    this.lastFailure = null;
    this.coordinator.handleRingAction("exit");
    this.requestRender();
  }

  private applyOutcome(outcome: MathBranchOutcome | null): void {
    if (outcome?.kind === "value") {
      this.lastAnswer = outcome.text;
      this.lastFailure = null;
    } else if (outcome?.kind === "failure") {
      this.lastFailure = outcome.reason;
    }
    this.requestRender();
  }

  private handleCoordinatorChanged(): void {
    // The answer a deeper pass produced arrives on its own channel; fold it
    // into the standing answer the moment it lands.
    const deep = this.coordinator.deepAnswer;
    if (deep && deep !== this.lastDeepAnswer) {
      this.lastDeepAnswer = deep;
      this.applyOutcome(deep);
      return;
    }
    this.requestRender();
  }

  // -------------------------------------------------------------------------
  // Dictation

  /**
   * Arm exactly one finalized utterance. One, not a listening window: the
   * indicator on the lens is what makes this honest, and a calculator that
   * quietly held the microphone open would be indistinguishable from one
   * that did not.
   */
  beginDictation(): void {
    if (this.dictating) return;
    this.dictating = true;
    void this.actions.startVoiceCapture(true);
    this.requestRender();
  }

  cancelDictation(): void {
    if (!this.dictating) return;
    this.dictating = false;
    void this.actions.stopVoiceCapture();
    this.requestRender();
  }

  /**
   * A finalized utterance reached the app.
   *
   * In tap mode this only ever arrives because the wearer armed it, so it is
   * always taken. In continuous mode it also arrives from ordinary room
   * speech, and there it has to clear the looks-like-maths gate first —
   * otherwise every sentence in the room becomes a failed calculation on the
   * lens.
   */
  private onTranscript(event: VoiceTranscriptEvent): void {
    if (!event.isFinal) return;
    const text = event.text.trim();
    if (!text) return;
    const armed = this.dictating;
    const continuous = this.continuousActive && this.foreground;
    if (!armed && !continuous) return;
    if (armed) {
      this.dictating = false;
      void this.actions.stopVoiceCapture();
    }
    // A standing offer or a run in flight owns the next yes/no said in the
    // room ("keep going", "never mind", "stop").
    const longRunAnswer = this.coordinator.handleLongRunUtterance(text);
    if (longRunAnswer) {
      this.applyOutcome(longRunAnswer);
      return;
    }
    if (armed && isDictationCancellation(text)) {
      this.requestRender();
      return;
    }
    if (!armed && !isWorthAnswering(text)) return;
    this.submit(text);
  }

  // -------------------------------------------------------------------------
  // Input

  receiveTextInput(text: string): void {
    this.submit(text);
  }

  handleInput(event: InputEvent, _ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-up":
      case "scroll-down": {
        const forward = event.type === "scroll-down";
        // While Explain is showing a step sequence the scroll walks it — the
        // coordinator owns that, and asking it first is what keeps one
        // gesture from meaning two things at once. Otherwise scroll cycles
        // the MODE, because the mode is what the wearer changes between
        // problems and the steps only exist inside one of the three modes.
        if (this.mode === "explain" && this.coordinator.stepPosition !== null) {
          this.applyOutcome(this.coordinator.handleRingAction(forward ? "forward" : "back"));
          return;
        }
        const next = cycleMode(this.mode, forward);
        if (this.coordinator.hasProblem) {
          this.performFollowUp(next);
        } else {
          calculatorModeSetting.set(next);
          this.requestRender();
        }
        return;
      }

      case "click": {
        // A standing offer owns the tap: accept and start the long run.
        if (this.coordinator.hasLongRunInteraction) {
          this.applyOutcome(this.coordinator.handleRingAction("commit"));
          return;
        }
        if (this.dictating) {
          this.cancelDictation();
        } else {
          this.beginDictation();
        }
        return;
      }

      case "double-click": {
        if (this.dictating) {
          this.cancelDictation();
          return;
        }
        if (this.coordinator.isRunningLong || this.coordinator.pendingLongRun) {
          // Stop the run, or turn the offer down; the shallow answer stands.
          this.applyOutcome(this.coordinator.handleRingAction("exit"));
          return;
        }
        // The standard leave-the-app gesture.
        shell.yieldFocusToSidebar();
        return;
      }

      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Paint

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const small = getDefaultSmallFont();

    this.paintTabs(image, small, width);

    const footerY = height - small.lineHeight - 6;
    const bodyTop = 46;
    let bodyBottom = footerY - 4;

    // A standing offer or a running deep pass takes the rows just above the
    // footer, whatever view is behind it.
    const offer = this.coordinator.pendingLongRun;
    const progress = this.coordinator.longRunProgress;
    if (offer || progress) {
      bodyBottom = this.paintLongRunPanel(image, small, width, bodyBottom, offer, progress);
    }

    if (this.working) {
      this.drawCentered(image, small, Math.round((bodyTop + bodyBottom) / 2) - 8, "Working…", 180);
    } else if (this.lastFailure !== null) {
      this.paintFailure(image, small, width, bodyTop, bodyBottom);
    } else if (this.mode === "explain" && this.coordinator.stepPosition !== null) {
      this.paintExplain(image, width, bodyTop, bodyBottom);
    } else if (this.mode === "graph" && this.coordinator.lastGraph) {
      this.paintGraph(image, small, width, bodyTop, bodyBottom);
    } else if (this.lastAnswer) {
      this.paintAnswer(image, width, bodyTop, bodyBottom);
    } else {
      this.paintEmpty(image, small, width, bodyTop, bodyBottom);
    }

    image.drawText(small, 24, footerY, this.footerHints(), 110);
    return image;
  }

  /** The three modes as tabs, plus the deg/listening status chips. */
  private paintTabs(image: GrayImage, font: UiFont, width: number): void {
    let x = 24;
    for (const mode of CALCULATOR_MODES) {
      const label = modeLabel(mode);
      const active = mode === this.mode;
      image.drawText(font, x, 15, label, active ? 245 : 105);
      image.drawLine(x, 35, x + font.measureText(label), 35, active ? 200 : 30);
      x += font.measureText(label) + 18;
    }

    const chips: string[] = [];
    if (calculatorDegreesSetting.get()) chips.push("deg");
    if (this.dictating) chips.push("listening…");
    else if (this.continuousActive && this.foreground) chips.push("mic on");
    if (chips.length > 0) {
      const text = chips.join(" · ");
      image.drawText(font, width - 24 - font.measureText(text), 15, text, this.dictating ? 220 : 110);
    }
  }

  private paintFailure(
    image: GrayImage,
    font: UiFont,
    width: number,
    bodyTop: number,
    bodyBottom: number,
  ): void {
    this.paintHeardLine(image, font, width, bodyTop);
    const top = this.lastInput ? bodyTop + lineStep(font) + 6 : bodyTop + 8;
    const lines = wrapText(font, this.lastFailure ?? "", width - 64);
    const step = lineStep(font);
    const maxLines = Math.max(1, Math.floor((bodyBottom - top) / step));
    for (let index = 0; index < Math.min(lines.length, maxLines); index++) {
      image.drawText(font, 32, top + index * step, lines[index]!, 200);
    }
  }

  private paintExplain(image: GrayImage, width: number, bodyTop: number, bodyBottom: number): void {
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const position = this.coordinator.stepPosition;
    const steps = this.coordinator.explanationSteps;
    const step = position ? steps[position.index] : undefined;
    if (!position || !step) return;

    let y = bodyTop + 2;
    image.drawText(small, 24, y, `Step ${position.index + 1} of ${position.total}`, 130);
    y += lineStep(small) + 2;
    image.drawText(medium, 24, y, truncateText(medium, step.title, width - 48), 245);
    y += lineStep(medium) + 2;
    image.drawText(medium, 24, y, truncateText(medium, plain(step.expression), width - 48), 220);
    y += lineStep(medium) + 6;

    const detailLines = wrapText(small, step.detail, width - 64);
    const stepPitch = lineStep(small);
    const maxLines = Math.max(0, Math.floor((bodyBottom - y) / stepPitch));
    for (let index = 0; index < Math.min(detailLines.length, maxLines); index++) {
      image.drawText(small, 32, y + index * stepPitch, detailLines[index]!, 150);
    }
  }

  private paintGraph(
    image: GrayImage,
    font: UiFont,
    width: number,
    bodyTop: number,
    bodyBottom: number,
  ): void {
    const graph = this.coordinator.lastGraph;
    if (!graph) return;
    const headline = this.lastAnswer.split("\n")[0] ?? "";
    image.drawText(font, 24, bodyTop, truncateText(font, headline, width - 48), 200);
    const plotTop = bodyTop + lineStep(font) + 4;
    drawGraph(image, graph, {
      x: 18,
      y: plotTop,
      width: width - 36,
      height: Math.max(2, bodyBottom - plotTop),
    });
  }

  private paintAnswer(image: GrayImage, width: number, bodyTop: number, bodyBottom: number): void {
    const small = getDefaultSmallFont();
    this.paintHeardLine(image, small, width, bodyTop);
    const top = this.lastInput ? bodyTop + lineStep(small) + 4 : bodyTop;

    // A short single-line answer earns the large font; anything longer drops
    // to the medium font and wraps.
    const lines = this.lastAnswer.split("\n");
    const large = getDefaultLargeFont();
    if (lines.length === 1 && large.measureText(lines[0]!) <= width - 64) {
      const y = Math.round((top + bodyBottom - large.lineHeight) / 2);
      this.drawCentered(image, large, y, lines[0]!, 245);
      return;
    }
    const medium = getDefaultMediumFont();
    const wrapped = lines.flatMap((line) => wrapText(medium, line, width - 64));
    const step = lineStep(medium);
    const maxLines = Math.max(1, Math.floor((bodyBottom - top) / step));
    const shown = wrapped.slice(0, maxLines);
    let y = Math.max(top, Math.round((top + bodyBottom - shown.length * step) / 2));
    for (const line of shown) {
      this.drawCentered(image, medium, y, line, 235);
      y += step;
    }
  }

  private paintEmpty(
    image: GrayImage,
    font: UiFont,
    width: number,
    bodyTop: number,
    bodyBottom: number,
  ): void {
    const prompt =
      this.listening === "continuous"
        ? `Say a problem, then "${modeLabel(this.mode).toLowerCase()} it"`
        : "Tap to say a problem — or use Voice input to type one";
    const lines = wrapText(font, prompt, width - 96);
    const step = lineStep(font);
    let y = Math.round((bodyTop + bodyBottom - lines.length * step) / 2);
    for (const line of lines) {
      this.drawCentered(image, font, y, line, 150);
      y += step;
    }
  }

  private paintHeardLine(image: GrayImage, font: UiFont, width: number, y: number): void {
    if (!this.lastInput) return;
    const label = "Heard";
    image.drawText(font, 24, y, label, 110);
    const x = 24 + font.measureText(label) + 10;
    image.drawText(font, x, y, truncateText(font, this.lastInput, width - x - 24), 160);
  }

  /**
   * The standing offer, or the live progress of an accepted run, in the two
   * rows above the footer. Returns the new body bottom.
   */
  private paintLongRunPanel(
    image: GrayImage,
    font: UiFont,
    width: number,
    bodyBottom: number,
    offer: LongRunOffer | null,
    progress: LongRunProgress | null,
  ): number {
    const step = lineStep(font);
    const lines = progress
      ? [`${progressText(progress)} · ${Math.round(progress.elapsedSeconds)}s`]
      : offer
        ? offerGlassesPrompt(offer).split("\n")
        : [];
    const panelTop = bodyBottom - lines.length * step - 6;
    image.drawLine(16, panelTop, width - 16, panelTop, 40);
    for (let index = 0; index < lines.length; index++) {
      image.drawText(font, 24, panelTop + 4 + index * step, truncateText(font, lines[index]!, width - 48), 190);
    }
    return panelTop - 2;
  }

  private footerHints(): string {
    if (this.coordinator.longRunProgress) {
      return gestureHints([[GESTURE_DOUBLE_CLICK, "stop"]]);
    }
    if (this.coordinator.pendingLongRun) {
      return gestureHints([
        [GESTURE_CLICK, "keep going"],
        [GESTURE_DOUBLE_CLICK, "leave it"],
      ]);
    }
    if (this.dictating) {
      return gestureHints([
        [GESTURE_CLICK, "cancel mic"],
        [GESTURE_DOUBLE_CLICK, "cancel"],
      ]);
    }
    const scrollTarget =
      this.mode === "explain" && this.coordinator.stepPosition !== null ? "steps" : "mode";
    return gestureHints([
      [GESTURE_SCROLL, scrollTarget],
      [GESTURE_CLICK, "mic"],
      [GESTURE_DOUBLE_CLICK, "back"],
    ]);
  }

  private drawCentered(image: GrayImage, font: UiFont, y: number, text: string, value: number): void {
    const x = Math.max(0, Math.round((image.width - font.measureText(text)) / 2));
    image.drawText(font, x, y, text, value);
  }
}
