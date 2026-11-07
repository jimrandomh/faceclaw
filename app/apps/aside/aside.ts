import { type LlmStreamHandle } from "../../assistant/llm-protocol";
import { type ResolvedAssistantModel } from "../../assistant/models";
import { GrayImage, type UiFont } from "../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../graphics/ui-fonts";
import { writeTextToDownloads } from "../../native/file-access";
import { voiceControlBridge } from "../../native/voice-control";
import { openSettingsSubMenu } from "../../ui/dashboard/settings-panel";
import { enumSettingMenuItem, textSettingMenuItem, toggleSettingMenuItem } from "../../ui/dashboard-settings";
import { type InputEvent } from "../../ui/gestures";
import { type Layer, type LayerContext } from "../../ui/layers";
import { MicLevelMeter, paintListeningHeader } from "../../ui/listening-header";
import { type MenuItem } from "../../ui/menu";
import { lineStep } from "../../ui/metrics";
import { formatRelativeTime } from "../../util/date-util";
import { TranscriptScroll, wrapTranscribeText } from "../transcribe/transcript-model";
import { cueContextLimits, resolveAsideModel, streamCueCheck, streamRecap } from "./aside-llm";
import { parseCueReply, parseRecap, parseRequestedCueReply, recapMarkdown } from "./aside-reply";
import {
  AsideSession,
  CUE_KIND_LABELS,
  cuePacing,
  formatSessionForSave,
  STOP_SETTLE_MS,
  type Cue,
  type CueCheck,
  type CuePacing,
  type CurrentCue,
} from "./aside-session";
import {
  addNotUsefulCue,
  asideAboutSetting,
  asideAutoSaveSetting,
  asideCaptionsSetting,
  asideCueDurationSetting,
  asideCueTtlMs,
  asideFrequencySetting,
  asideKeepDisplayOnSetting,
  asideModelSetting,
  asideNoticeSeenSetting,
  asidePrepNotesSetting,
  asideWakeDisplaySetting,
  clearNotUsefulCues,
  notUsefulCues,
} from "./aside-settings";

const NO_MODEL_PROBLEM = global.isIOS
  ? "Aside needs a language model: configure a cloud or OpenAI-compatible model in Settings > Assistant."
  : "Aside needs a language model: configure one in Settings > Assistant, or download the on-phone model.";
const NO_MODEL_NOTICE = "No language model is set up.";
const NOTICE =
  "Aside listens through the glasses and transcribes everyone in earshot, not only you. " +
  "Speech goes to your transcription provider and the text goes to your language model; on-phone ones keep it on the phone. " +
  "The transcript lasts until you close Aside, unless you choose Save.\n\n" +
  "Some places require everyone's consent to record or transcribe a conversation, so tell people when it matters.\n\n" +
  "Tap to start.";
const IDLE_HINT = "A cue appears here when something is worth knowing. Tap to ask for one.";

const TEXT_X = 32;
const BOTTOM_MARGIN = 6;
const TICK_MS = 500;
const FLASH_MS = 5_000;
// A stuck request would otherwise block every later check without a word.
const CLOUD_CHECK_TIMEOUT_MS = 45_000;
const LOCAL_CHECK_TIMEOUT_MS = 180_000;
/** Enough of the transcript's end to fill the display, without wrapping all of it each paint. */
const CAPTION_TAIL_CHARS = 3_000;
const CAPTION_LAST_LINES = 3;

const LABEL_GRAY = 130;
const HEADLINE_GRAY = 255;
const DETAIL_GRAY = 190;
const DIM_CAPTION_GRAY = 110;
const FULL_CAPTION_GRAY = 180;
const TEXT_GRAY = 230;
const HEADING_GRAY = 255;
const BODY_GRAY = 200;

type Line = { text: string; gray: number };

type RecapState = {
  phase: "none" | "settling" | "writing" | "done" | "failed" | "empty";
  text: string;
  error: string;
  /** The transcript length it was written from, so an unchanged one needn't be redone. */
  coveredChars: number;
};

const NO_RECAP: RecapState = { phase: "none", text: "", error: "", coveredChars: 0 };

/** What the app wrapper does for the layer. */
export type AsideHost = {
  startCapture: () => void;
  stopCapture: () => void;
  /**
   * A cue just reached the wearer: get it in front of them if the window isn't.
   * Returns whether that woke the display for this window.
   */
  announceCue: (cue: Cue) => boolean;
  /** The cue that woke the display ended with no input since: back to dark. */
  sleepDisplay: () => void;
};

/**
 * Aside's window content: the cue on screen with dim captions around it, plus
 * the transcript and recap views. The conversation's state and pacing live in
 * AsideSession; this layer drives it with the clock and talks to the model.
 * Continuous mic capture is owned by the app wrapper (createAsideAppWindow).
 */
export class AsideLayer implements Layer {
  private status = "Starting microphone...";
  private listening = false;
  private detail = "";
  // Why listening hasn't started: the first-launch notice, or no model.
  private setup: "notice" | "no-model" | null = null;
  private view: "live" | "transcript" | "recap" = "live";
  private modelError = "";
  private flashText = "";
  private flashUntilMs = 0;
  private wokeDisplay = false;
  private recap: RecapState = NO_RECAP;
  private readonly session = new AsideSession(asideCueTtlMs);
  private readonly transcriptScroll = new TranscriptScroll();
  private recapScroll = new TranscriptScroll(false);
  private readonly meter = new MicLevelMeter();
  private checkHandle: LlmStreamHandle | null = null;
  private recapHandle: LlmStreamHandle | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private requestRender: () => void = () => {};
  private isVisible: () => boolean = () => false;
  private removed = false;
  private unsubscribers: Array<() => void> = [];

  /** `stamp` names the saved file. */
  constructor(private readonly stamp: string, private readonly host: AsideHost) {}

  /** `isVisible` says whether the window is on screen (hidden windows skip repaints; see refresh). */
  start(requestRender: () => void, isVisible: () => boolean): void {
    this.requestRender = requestRender;
    this.isVisible = isVisible;
    this.meter.start(requestRender, isVisible);
    this.unsubscribers = [
      voiceControlBridge.onTranscript((event) => {
        if (this.setup) return;
        const firstSpeech = !this.session.hasSpeech; // clears the idle hint
        if (!this.session.accept(event, Date.now())) return;
        if (firstSpeech || this.showsSpeech()) this.repaint();
      }),
      voiceControlBridge.onSpeechPause(() => this.session.speechPause()),
      voiceControlBridge.onStatus((state) => {
        this.status = state.status;
        this.listening = state.listening;
        this.detail = state.detail;
        this.repaint();
      }),
    ];
    this.ticker = setInterval(() => this.onTick(), TICK_MS);
    this.begin();
  }

  /** Run the first-launch notice and setup check, then start listening. */
  private begin(): void {
    if (!asideNoticeSeenSetting.get()) {
      this.setup = "notice";
    } else if (!resolveAsideModel()) {
      this.setup = "no-model";
    } else {
      this.setup = null;
      this.host.startCapture();
    }
    this.repaint();
  }

  /** Repaint because the window came on screen, after updates it skipped while hidden. */
  refresh(): void {
    this.requestRender();
  }

  private repaint(): void {
    if (this.isVisible()) this.requestRender();
  }

  private flash(text: string): void {
    this.flashText = text;
    this.flashUntilMs = Date.now() + FLASH_MS;
    this.repaint();
  }

  /** Whether new speech changes what's painted (with captions off, it doesn't: far fewer frames). */
  private showsSpeech(): boolean {
    if (this.view === "transcript") return true;
    if (this.view !== "live") return false;
    return asideCaptionsSetting.get() !== "off" && !this.session.current?.expanded;
  }

  /** While a cue, a recap being written, or the setting wants it on (see ShellWindow.keepsScreenOn). */
  wantsScreenOn(): boolean {
    if (this.setup) return false;
    if (this.recap.phase === "settling" || this.recap.phase === "writing") return true;
    if (this.session.current) return true;
    return asideKeepDisplayOnSetting.get() && !this.session.stopped;
  }

  private onTick(): void {
    if (this.removed) return;
    const nowMs = Date.now();
    let dirty = false;
    const model = resolveAsideModel();
    const overdue = this.session.overdueCheck(nowMs, model?.provider === "local" ? LOCAL_CHECK_TIMEOUT_MS : CLOUD_CHECK_TIMEOUT_MS);
    if (overdue) {
      this.checkHandle?.cancel();
      this.checkHandle = null;
      this.failCheck(overdue, "timed out");
    }
    const hadCue = this.session.current !== null;
    const { changed, shown } = this.session.tick(nowMs);
    dirty = changed;
    if (shown) {
      if (this.view === "transcript") this.flash("New cue: tap to see it");
      this.wokeDisplay = this.host.announceCue(shown);
    } else if (hadCue && this.wokeDisplay && !this.session.current) {
      this.wokeDisplay = false;
      this.host.sleepDisplay();
    }
    if (this.flashText && nowMs >= this.flashUntilMs) {
      this.flashText = "";
      dirty = true;
    }
    if (!this.setup) dirty = this.startDueCheck(model, nowMs) || dirty;
    if (dirty) this.repaint();
  }

  private pacing(model: ResolvedAssistantModel): CuePacing | null {
    return cuePacing(asideFrequencySetting.get(), model.provider === "local");
  }

  /** Start a check if it's time for one. Returns whether the display needs updating. */
  private startDueCheck(model: ResolvedAssistantModel | null, nowMs: number): boolean {
    if (!model) {
      if (this.modelError === NO_MODEL_NOTICE) return false;
      this.modelError = NO_MODEL_NOTICE;
      return true;
    }
    const check = this.session.nextCheck(this.pacing(model), nowMs, cueContextLimits(model));
    if (!check) return false;
    const frequency = asideFrequencySetting.get();
    this.runCheck(model, check, frequency === "on-request" ? null : frequency);
    return false;
  }

  /** The wearer asked, by a tap or by typing or dictating `question`. */
  private askNow(question = ""): void {
    const model = resolveAsideModel();
    if (!model) {
      this.flash(NO_MODEL_NOTICE);
      return;
    }
    const check = this.session.requestCheck(Date.now(), cueContextLimits(model), question);
    if (!check) {
      this.flash("Nothing heard yet.");
      return;
    }
    this.checkHandle?.cancel();
    this.checkHandle = null;
    this.runCheck(model, check, null);
    this.repaint();
  }

  /** Text aimed at this window: a question for the model, with the conversation as context. */
  receiveText(text: string): void {
    if (this.setup || !text.trim()) return;
    this.view = "live";
    this.askNow(text);
  }

  private runCheck(model: ResolvedAssistantModel, check: CueCheck, bar: Parameters<typeof streamCueCheck>[2]): void {
    const handle = streamCueCheck(model, check, bar, {
      onDone: (reply) => this.finishCheck(model, check, reply),
      onError: (message) => this.failCheck(check, message),
    });
    // A provider that fails synchronously has already settled.
    if (this.session.isActive(check)) this.checkHandle = handle;
  }

  private finishCheck(model: ResolvedAssistantModel, check: CueCheck, reply: string): void {
    if (!this.session.isActive(check)) return;
    this.checkHandle = null;
    this.modelError = "";
    const requested = check.reason === "request";
    const draft = requested ? parseRequestedCueReply(reply) : parseCueReply(reply);
    const pacing = this.pacing(model);
    const outcome = this.session.complete(check, draft, Date.now(), {
      minScore: pacing?.minScore ?? 0,
      maxAgeMs: pacing?.maxCueAgeMs ?? Infinity,
      avoid: notUsefulCues(),
    });
    // Outcomes only, never content: enough to tune the pacing from logcat.
    console.log(`aside: ${check.reason} check took ${Date.now() - check.startedAtMs} ms: ${outcome}`);
    if (requested && outcome === "none") this.flash("Nothing useful to add right now.");
    this.onTick();
    this.repaint();
  }

  private failCheck(check: CueCheck, message: string): void {
    if (!this.session.isActive(check)) return;
    this.checkHandle = null;
    this.session.fail(check);
    this.modelError = `Model error: ${message}`;
    this.repaint();
  }

  private pause(): void {
    this.session.stop(Date.now());
    this.checkHandle?.cancel();
    this.checkHandle = null;
    this.host.stopCapture();
    this.repaint();
  }

  private resume(): void {
    this.recapHandle?.cancel();
    this.recapHandle = null;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    // A recap still unwritten is moot, while a finished one stays until the next.
    if (this.recap.phase !== "done") this.recap = NO_RECAP;
    this.session.resume();
    this.view = "live";
    this.host.startCapture();
    this.repaint();
  }

  private endAndRecap(): void {
    const wasListening = !this.session.stopped;
    if (wasListening) this.pause();
    this.view = "recap";
    const { phase, coveredChars } = this.recap;
    const covered = this.session.transcript.text.trim().length;
    if (phase === "settling" || phase === "writing" || (phase === "done" && coveredChars === covered)) {
      this.repaint();
      return;
    }
    this.recap = { ...NO_RECAP, phase: "settling" };
    this.recapScroll = new TranscriptScroll(false);
    // The final words may still be on their way from the recognizer.
    this.settleTimer = setTimeout(() => this.writeRecap(), wasListening ? STOP_SETTLE_MS : 0);
    this.repaint();
  }

  private writeRecap(): void {
    this.settleTimer = null;
    if (this.removed) return;
    this.session.commitLive();
    const transcript = this.session.transcript.text.trim();
    if (!transcript) {
      this.recap = { ...NO_RECAP, phase: "empty" };
      this.repaint();
      return;
    }
    const model = resolveAsideModel();
    if (!model) {
      this.recap = { ...NO_RECAP, phase: "failed", error: NO_MODEL_NOTICE };
      this.repaint();
      return;
    }
    const recap: RecapState = { phase: "writing", text: "", error: "", coveredChars: transcript.length };
    this.recap = recap;
    this.repaint();
    this.recapHandle = streamRecap(model, transcript, {
      onProgress: (text) => {
        if (this.recap !== recap) return;
        recap.text = text;
        this.repaint();
      },
      onDone: (text) => {
        if (this.recap !== recap) return;
        this.recapHandle = null;
        recap.text = text;
        recap.phase = "done";
        if (asideAutoSaveSetting.get()) this.save();
        this.repaint();
      },
      onError: (message) => {
        if (this.recap !== recap) return;
        this.recapHandle = null;
        recap.phase = "failed";
        recap.error = message;
        this.repaint();
      },
    });
  }

  private notUseful(): void {
    const current = this.session.current;
    if (!current) return;
    addNotUsefulCue(current.cue.headline);
    this.session.dismiss();
    this.flash("Noted: fewer like that.");
  }

  /** Save to Downloads; true if a file was written. */
  private save(): boolean {
    const transcript = this.session.transcript.text.trim();
    if (!transcript) {
      this.flash("Nothing to save yet.");
      return false;
    }
    const recap = parseRecap(this.recap.phase === "done" ? this.recap.text : "");
    const filename = `aside-${this.stamp}.md`;
    const text = formatSessionForSave({ title: recap.title, recap: recapMarkdown(recap), cues: this.session.cues, transcript });
    const path = writeTextToDownloads(filename, text);
    this.flash(path ? `Saved ${filename}` : "Save failed (check file access).");
    return path !== null;
  }

  menuItems(): MenuItem[] {
    const action = (label: string, run: () => void): MenuItem => ({
      label,
      onSelect: (ctx) => {
        ctx.stack.pop();
        run();
      },
    });
    const settings: MenuItem = {
      label: "Aside settings",
      onSelect: (ctx) => {
        ctx.stack.pop();
        openSettingsSubMenu(ctx, "Aside settings", [
          enumSettingMenuItem(asideFrequencySetting),
          enumSettingMenuItem(asideCueDurationSetting),
          enumSettingMenuItem(asideCaptionsSetting, { onChange: () => this.repaint() }),
          toggleSettingMenuItem(asideWakeDisplaySetting),
          toggleSettingMenuItem(asideKeepDisplayOnSetting),
          enumSettingMenuItem(asideModelSetting),
          textSettingMenuItem(asideAboutSetting),
          toggleSettingMenuItem(asideAutoSaveSetting),
          {
            label: "Forget Not useful marks",
            description: "Clear the list of cues you marked Not useful, which Aside avoids repeating.",
            disabled: () => notUsefulCues().length === 0,
            onSelect: () => {
              clearNotUsefulCues();
              this.flash("Not useful marks cleared.");
            },
          },
        ]);
      },
    };
    if (this.setup) return [settings];
    const items: MenuItem[] = [];
    if (this.view !== "recap" || this.recap.phase === "failed") {
      items.push(action("End and recap", () => this.endAndRecap()));
    }
    items.push(this.session.stopped ? action("Resume", () => this.resume()) : action("Pause", () => this.pause()));
    if (this.view === "live" && this.session.current) items.push(action("Not useful", () => this.notUseful()));
    items.push(this.view === "transcript"
      ? action("Back to cues", () => this.showView("live"))
      : action("Transcript", () => this.showView("transcript")));
    if (this.view !== "recap" && this.recap.phase === "done") items.push(action("Recap", () => this.showView("recap")));
    items.push(textSettingMenuItem(asidePrepNotesSetting));
    items.push(action("Save", () => this.save()));
    items.push(settings);
    return items;
  }

  private showView(view: AsideLayer["view"]): void {
    this.view = view;
    this.requestRender();
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    this.wokeDisplay = false;
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      this.scroll(event.type === "scroll-up" ? -1 : 1);
    } else if (event.type === "click") {
      this.tap();
    } else if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }

  private scroll(delta: -1 | 1): void {
    if (this.setup) return;
    if (this.view === "live") {
      if (this.session.scrollCues(delta, Date.now())) this.requestRender();
      return;
    }
    (this.view === "transcript" ? this.transcriptScroll : this.recapScroll).scroll(delta * 3);
    this.requestRender();
  }

  private tap(): void {
    if (this.setup === "notice") asideNoticeSeenSetting.set(true);
    if (this.setup) {
      this.begin();
      return;
    }
    if (this.view === "transcript") {
      this.showView("live");
      return;
    }
    if (this.view === "recap") {
      if (this.recap.phase === "failed") this.endAndRecap();
      return;
    }
    if (this.session.tap(Date.now())) {
      this.requestRender();
      return;
    }
    if (this.session.stopped) this.resume();
    else if (!this.session.requestInFlight) this.askNow();
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const meter = this.listening && !this.session.stopped && !this.setup ? this.meter : null;
    const bodyTop = paintListeningHeader(image, font, "Aside", this.headerStatus(), meter);
    if (this.setup) {
      this.paintLines(image, font, this.textLines(font, this.setup === "notice" ? NOTICE : `${NO_MODEL_PROBLEM}\n\nTap to check again.`, width, TEXT_GRAY), bodyTop, height);
    } else if (this.view === "transcript") {
      const text = this.session.transcript.text || "Nothing heard yet.";
      this.paintScrollable(image, font, this.textLines(font, text, width, TEXT_GRAY), this.transcriptScroll, bodyTop, width, height);
    } else if (this.view === "recap") {
      this.paintScrollable(image, font, this.recapLines(font, width), this.recapScroll, bodyTop, width, height);
    } else {
      this.paintLive(image, bodyTop, width, height);
    }
    return image;
  }

  private headerStatus(): string {
    if (this.flashText) return this.flashText;
    if (this.setup) return this.setup === "notice" ? "Before you start" : "Setup needed";
    if (this.view === "recap") return this.recapStatus();
    if (this.view === "transcript") return this.session.stopped ? "Transcript, paused" : "Transcript";
    if (this.session.stopped) return "Paused: tap to resume";
    const position = this.session.current?.position;
    if (position) {
      const age = formatRelativeTime(this.session.current!.cue.shownAtMs);
      const unseen = this.session.unseenCues;
      return `Cue ${position.index} of ${position.total}, ${age === "now" ? "just now" : `${age} ago`}${unseen ? `, ${unseen} new` : ""}`;
    }
    if (this.session.requestInFlight) return "Thinking...";
    return this.modelError || this.status;
  }

  private recapStatus(): string {
    switch (this.recap.phase) {
      case "settling":
        return "Finishing the transcript...";
      case "writing":
        return "Writing recap...";
      case "failed":
        return "Recap failed";
      default:
        return "Recap";
    }
  }

  private paintLive(image: GrayImage, bodyTop: number, width: number, height: number): void {
    const small = getDefaultSmallFont();
    const bottom = height - BOTTOM_MARGIN;
    const current = this.session.current;
    let y = bodyTop;
    if (current) y = this.paintCue(image, current, y, bottom, width);
    const text = this.session.transcript.text;
    if (!current && !text) {
      const hint = this.listening ? IDLE_HINT : this.detail;
      this.paintLines(image, small, this.textLines(small, hint, width, DIM_CAPTION_GRAY), y, height);
      return;
    }
    const mode = asideCaptionsSetting.get();
    if (mode === "off" || current?.expanded) return;
    const lines = wrapTranscribeText((line) => small.measureText(line), text.slice(-CAPTION_TAIL_CHARS), width - 2 * TEXT_X)
      .filter((line) => line.trim());
    const step = lineStep(small) + 2;
    const room = Math.floor((bottom - y - small.lineHeight) / step) + 1;
    const count = Math.max(0, Math.min(room, mode === "last" ? CAPTION_LAST_LINES : room));
    const shown = count ? lines.slice(-count) : [];
    const gray = mode === "last" ? DIM_CAPTION_GRAY : FULL_CAPTION_GRAY;
    const firstY = bottom - small.lineHeight - (shown.length - 1) * step;
    shown.forEach((line, index) => image.drawText(small, TEXT_X, firstY + index * step, line, gray));
  }

  /** Returns the y below the cue. */
  private paintCue(image: GrayImage, current: CurrentCue, top: number, bottom: number, width: number): number {
    const small = getDefaultSmallFont();
    const medium = getDefaultMediumFont();
    const { cue, expanded } = current;
    const maxWidth = width - 2 * TEXT_X;
    const label = CUE_KIND_LABELS[cue.kind].toUpperCase() + (cue.detail && !expanded ? " · tap for more" : "");
    image.drawText(small, TEXT_X, top, label, LABEL_GRAY);
    let y = top + lineStep(small) + 2;
    for (const line of wrapTranscribeText((text) => medium.measureText(text), cue.headline, maxWidth)) {
      image.drawText(medium, TEXT_X, y, line, HEADLINE_GRAY);
      y += lineStep(medium) + 2;
    }
    if (!expanded || !cue.detail) return y + 6;
    y += 6;
    const step = lineStep(small) + 2;
    for (const line of wrapTranscribeText((text) => small.measureText(text), cue.detail, maxWidth)) {
      if (y + small.lineHeight > bottom) break;
      image.drawText(small, TEXT_X, y, line, DETAIL_GRAY);
      y += step;
    }
    return y + 6;
  }

  private textLines(font: UiFont, text: string, width: number, gray: number): Line[] {
    return wrapTranscribeText((line) => font.measureText(line), text, width - 2 * TEXT_X).map((line) => ({ text: line, gray }));
  }

  private recapLines(font: UiFont, width: number): Line[] {
    const { phase, error, text } = this.recap;
    if (phase === "settling") return [];
    if (phase === "empty") return this.textLines(font, "Nothing was heard, so there's nothing to recap.", width, TEXT_GRAY);
    if (phase === "failed") {
      return this.textLines(font, `${error}\n\nTap to try again. The transcript is kept, and Save still works.`, width, TEXT_GRAY);
    }
    const recap = parseRecap(text);
    const lines: Line[] = recap.title ? this.textLines(font, recap.title, width, HEADING_GRAY) : [];
    for (const line of recap.lines) {
      if (line.heading && lines.length) lines.push({ text: "", gray: 0 });
      lines.push(...this.textLines(font, line.text, width, line.heading ? HEADING_GRAY : BODY_GRAY));
    }
    return lines;
  }

  private paintLines(image: GrayImage, font: UiFont, lines: Line[], top: number, height: number): void {
    const step = lineStep(font) + 2;
    lines.forEach((line, index) => {
      const y = top + index * step;
      if (y + font.lineHeight <= height) image.drawText(font, TEXT_X, y, line.text, line.gray);
    });
  }

  private paintScrollable(image: GrayImage, font: UiFont, lines: Line[], scroll: TranscriptScroll, bodyTop: number, width: number, height: number): void {
    const step = lineStep(font) + 2;
    const bodyLines = Math.max(1, Math.floor((height - BOTTOM_MARGIN - bodyTop - font.lineHeight) / step) + 1);
    const firstLine = scroll.layout(lines.length, bodyLines);
    for (let index = firstLine; index < Math.min(lines.length, firstLine + bodyLines); index++) {
      image.drawText(font, TEXT_X, bodyTop + (index - firstLine) * step, lines[index]!.text, lines[index]!.gray);
    }
    if (lines.length > bodyLines) {
      const trackHeight = height - bodyTop - BOTTOM_MARGIN;
      const thumbHeight = Math.max(8, Math.round(trackHeight * bodyLines / lines.length));
      const thumbY = bodyTop + Math.round((trackHeight - thumbHeight) * firstLine / (lines.length - bodyLines));
      image.fillRect(width - 14, bodyTop, 2, trackHeight, 45);
      image.fillRect(width - 14, thumbY, 2, thumbHeight, 140);
    }
  }

  onRemoved(): void {
    if (this.removed) return;
    this.removed = true;
    this.meter.stop();
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.checkHandle?.cancel();
    this.checkHandle = null;
    this.recapHandle?.cancel();
    this.recapHandle = null;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    if (asideAutoSaveSetting.get() && this.session.hasSpeech) this.save();
  }
}
