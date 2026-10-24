import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { lineStep } from "../../ui/metrics";
import { writeTextToDownloads } from "../../native/file-access";
import { voiceControlBridge } from "../../native/voice-control";
import { Layer, type LayerContext } from "../../ui/layers";
import { type InputEvent } from "../../ui/gestures";
import { type LlmStreamHandle } from "../../assistant/llm-protocol";
import { TranscriptScroll, wrapTranscribeText } from "../transcribe/transcript-model";
import { TranslationModel, type TranslationJob, type TranslationLine } from "./translation-model";
import { resolveTranslationModel, streamTranslation } from "./translate-llm";
import { translateShowOriginalSetting } from "./translate-settings";

const NO_MODEL_NOTICE = "No language model is set up.";

/**
 * Live translation view. Continuous mic capture is owned by the app wrapper
 * (createTranslateAppWindow); this layer feeds finalized speech to the
 * assistant's model one stretch at a time, shows the English as it streams
 * in, and saves the session to Downloads from the app menu.
 */
export class TranslateLayer implements Layer {
  private status = "Starting microphone...";
  private listening = false;
  private detail = "";
  private saveNotice = "";
  private translationError = "";
  // Why the app can't run (no multilingual provider or no model); shown in
  // place of the transcript, and a tap asks the app wrapper to check again.
  private problem: string | null = null;
  private readonly model = new TranslationModel();
  private readonly scroll = new TranscriptScroll();
  private activeJob: TranslationJob | null = null;
  private activeHandle: LlmStreamHandle | null = null;
  private requestRender: () => void = () => {};
  private removed = false;
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  /** `stamp` names the saved transcript; `retry` re-runs the app's setup check. */
  constructor(private readonly stamp: string, private readonly retry: () => void) {}

  start(requestRender: () => void): void {
    this.requestRender = requestRender;
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => {
      this.model.accept(event);
      this.pump();
      requestRender();
    });
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      this.status = state.status;
      this.listening = state.listening;
      this.detail = state.detail;
      this.saveNotice = "";
      requestRender();
    });
  }

  setProblem(problem: string | null): void {
    this.problem = problem;
    this.requestRender();
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const measure = (line: string) => font.measureText(line);
    const maxWidth = width - 64;

    image.drawText(font, 24, 20, "Translate", 200);
    const status = this.problem ? "Setup needed" : this.translationError || this.status;
    image.drawText(font, 24, 40, this.saveNotice || status, 110);

    let lines: TranslationLine[];
    if (this.problem) {
      lines = wrapTranscribeText(measure, `${this.problem}\n\nTap to check again.`, maxWidth).map((text) => ({ text, gray: 230 }));
    } else {
      lines = this.model.lines(measure, maxWidth, translateShowOriginalSetting.get());
      if (!lines.length) {
        const placeholder = this.listening ? "Listening..." : this.detail;
        lines = wrapTranscribeText(measure, placeholder, maxWidth).map((text) => ({ text, gray: 230 }));
      }
    }

    const step = lineStep(font) + 2;
    const bodyTop = 62;
    const bodyLines = Math.max(1, Math.floor((height - 6 - bodyTop - font.lineHeight) / step) + 1);
    const firstLine = this.scroll.layout(lines.length, bodyLines);
    for (let index = firstLine; index < Math.min(lines.length, firstLine + bodyLines); index++) {
      const y = bodyTop + (index - firstLine) * step;
      image.drawText(font, 32, y, lines[index]!.text, lines[index]!.gray);
    }

    if (lines.length > bodyLines) {
      const trackHeight = height - bodyTop - 6;
      const thumbHeight = Math.max(8, Math.round(trackHeight * bodyLines / lines.length));
      const thumbY = bodyTop + Math.round((trackHeight - thumbHeight) * firstLine / (lines.length - bodyLines));
      image.fillRect(width - 14, bodyTop, 2, trackHeight, 45);
      image.fillRect(width - 14, thumbY, 2, thumbHeight, 140);
    }
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      this.scroll.scroll(event.type === "scroll-up" ? -3 : 3);
      ctx.actions.requestRender();
      return;
    }
    if (event.type === "click" && this.problem) {
      this.retry();
      return;
    }
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }

  onRemoved(): void {
    this.removed = true;
    this.activeJob = null;
    this.activeHandle?.cancel();
    this.activeHandle = null;
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
  }

  saveTranscript(): void {
    const text = this.model.savedText().trim();
    if (!text) {
      this.saveNotice = "Nothing to save yet.";
      return;
    }
    const filename = `translation-${this.stamp}.txt`;
    const path = writeTextToDownloads(filename, `${text}\n`);
    this.saveNotice = path ? `Saved ${filename}` : "Save failed (check file access).";
  }

  /** Start translating the next waiting stretch of speech, unless one is in flight. */
  private pump(): void {
    if (this.removed) return;
    const job = this.model.nextJob();
    if (!job) return;
    const llm = resolveTranslationModel();
    if (!llm) {
      // The model went away mid-session (a key was cleared): keep the original.
      this.model.fail(job.segment);
      this.translationError = NO_MODEL_NOTICE;
      this.pump();
      return;
    }
    this.activeJob = job;
    const handle = streamTranslation(llm, {
      speech: job.segment.source,
      context: job.context,
      onProgress: (textSoFar) => {
        if (this.activeJob !== job) return;
        this.model.progress(job.segment, textSoFar);
        this.requestRender();
      },
      onDone: (translation) => this.settle(job, () => {
        this.model.complete(job.segment, translation);
        this.translationError = "";
      }),
      onError: (message) => this.settle(job, () => {
        this.model.fail(job.segment);
        this.translationError = `Translation failed: ${message}`;
      }),
    });
    // A provider that fails synchronously has already settled (and moved on).
    if (this.activeJob === job) this.activeHandle = handle;
  }

  private settle(job: TranslationJob, apply: () => void): void {
    if (this.activeJob !== job) return;
    this.activeJob = null;
    this.activeHandle = null;
    apply();
    this.pump();
    this.requestRender();
  }
}
