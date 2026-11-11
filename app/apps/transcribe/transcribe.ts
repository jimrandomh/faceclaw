import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { lineStep } from "../../ui/metrics";
import { MicLevelMeter, paintListeningHeader } from "../../ui/listening-header";
import { writeTextToDownloads } from "../../native/file-access";
import { voiceControlBridge } from "../../native/voice-control";
import { Layer, type LayerContext } from "../../ui/layers";
import { type InputEvent } from "../../ui/gestures";
import { TranscriptModel, TranscriptScroll, transcriptLayout, wrapTranscribeText } from "./transcript-model";

/**
 * Live transcription view. Continuous mic capture is owned by the app wrapper
 * (createTranscribeAppWindow); this layer accumulates the transcript, shows
 * it, and saves it to Downloads from the app menu.
 */
export class TranscribeLayer implements Layer {
  private status = "Starting microphone...";
  private listening = false;
  private detail = "";
  private readonly transcript = new TranscriptModel();
  private readonly scroll = new TranscriptScroll();
  private readonly meter = new MicLevelMeter();
  private saveNotice = "";
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribePause: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  /** `stamp` names the saved transcript, matching the session's audio recording. */
  constructor(private readonly stamp: string = transcriptTimestamp()) {}

  /** `isVisible` says whether the window is on screen (the level meter repaints only then). */
  start(requestRender: () => void, isVisible: () => boolean): void {
    this.meter.start(requestRender, isVisible);
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => {
      this.transcript.accept(event);
      requestRender();
    });
    this.unsubscribePause = voiceControlBridge.onSpeechPause(() => this.transcript.pause());
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      this.status = state.status;
      this.listening = state.listening;
      this.detail = state.detail;
      this.saveNotice = "";
      requestRender();
    });
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const viewport = ctx.stack.getBaseSize();
    const image = new GrayImage(viewport.width, viewport.height, 0);

    const bodyTop = paintListeningHeader(image, font, "Transcribe", this.saveNotice || this.status, this.listening ? this.meter : null,
      viewport.padding);
    const step = lineStep(font) + 2;
    const layout = transcriptLayout(viewport, bodyTop, font.lineHeight, step);
    const text = this.transcript.text || (this.listening ? "Listening..." : this.detail);
    const wrapped = wrapTranscribeText((line) => font.measureText(line), text, layout.textWidth);

    const firstLine = this.scroll.layout(wrapped.length, layout.pageLines);
    for (let index = firstLine; index < Math.min(wrapped.length, firstLine + layout.drawnLines); index++) {
      const y = bodyTop + (index - firstLine) * step;
      image.drawText(font, layout.textX, y, wrapped[index]!, 230);
    }

    if (wrapped.length > layout.pageLines) {
      const track = layout.scrollbar;
      const thumbHeight = Math.max(8, Math.round(track.height * layout.pageLines / wrapped.length));
      const thumbY = track.y + Math.round((track.height - thumbHeight) * firstLine / (wrapped.length - layout.pageLines));
      image.fillRect(track.x, track.y, track.width, track.height, 45);
      image.fillRect(track.x, thumbY, track.width, thumbHeight, 140);
    }
    return image;
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    if (event.type === "scroll-up" || event.type === "scroll-down") {
      this.scroll.scroll(event.type === "scroll-up" ? -3 : 3);
      ctx.actions.requestRender();
      return;
    }
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }

  onRemoved(): void {
    this.meter.stop();
    this.unsubscribePause?.();
    this.unsubscribePause = null;
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
  }

  saveTranscript(): void {
    const text = this.transcript.text.trim();
    if (!text) {
      this.saveNotice = "Nothing to save yet.";
      return;
    }
    const filename = `transcript-${this.stamp}.txt`;
    const path = writeTextToDownloads(filename, `${text}\n`);
    this.saveNotice = path ? `Saved ${filename}` : "Save failed (check file access).";
  }
}

export function transcriptTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}
