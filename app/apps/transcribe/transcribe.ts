import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { lineStep } from "../../ui/metrics";
import { writeTextToDownloads } from "../../native/file-access";
import { voiceControlBridge } from "../../native/voice-control";
import { Layer, type LayerContext } from "../../ui/layers";
import { type InputEvent } from "../../ui/gestures";
import { TranscriptModel, TranscriptScroll, wrapTranscribeText } from "./transcript-model";

/**
 * Live transcription view. Continuous mic capture is owned by the app wrapper
 * (createTranscribeAppWindow); this layer accumulates the transcript, shows
 * it, and saves it to Downloads from the app menu.
 */
export class TranscribeLayer implements Layer {
  private status = "Listening...";
  private readonly transcript = new TranscriptModel();
  private readonly scroll = new TranscriptScroll();
  private saveNotice = "";
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribePause: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  start(requestRender: () => void): void {
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => {
      this.transcript.accept(event);
      requestRender();
    });
    this.unsubscribePause = voiceControlBridge.onSpeechPause(() => this.transcript.pause());
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      this.status = state.status;
      this.saveNotice = "";
      requestRender();
    });
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const text = this.transcript.text || "Listening...";
    const wrapped = wrapTranscribeText((text) => font.measureText(text), text, width - 64);

    image.drawText(font, 24, 20, "Transcribe", 200);
    image.drawText(font, 24, 40, this.saveNotice || this.status, 110);

    const step = lineStep(font) + 2;
    const bodyTop = 62;
    const bodyLines = Math.max(1, Math.floor((height - 6 - bodyTop - font.lineHeight) / step) + 1);
    const firstLine = this.scroll.layout(wrapped.length, bodyLines);
    for (let index = firstLine; index < Math.min(wrapped.length, firstLine + bodyLines); index++) {
      const y = bodyTop + (index - firstLine) * step;
      image.drawText(font, 32, y, wrapped[index]!, 230);
    }

    if (wrapped.length > bodyLines) {
      const trackHeight = height - bodyTop - 6;
      const thumbHeight = Math.max(8, Math.round(trackHeight * bodyLines / wrapped.length));
      const thumbY = bodyTop + Math.round((trackHeight - thumbHeight) * firstLine / (wrapped.length - bodyLines));
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
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }

  onRemoved(): void {
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
    const filename = `transcript-${transcriptTimestamp()}.txt`;
    const path = writeTextToDownloads(filename, `${text}\n`);
    this.saveNotice = path ? `Saved ${filename}` : "Save failed (check file access).";
  }
}

function transcriptTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}
