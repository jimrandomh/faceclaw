import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "../../graphics/image";
import { type BdfFont } from "../../graphics/bdffont";
import { voiceControlBridge, type VoiceTranscriptEvent } from "../../native/voice-control";
import { Layer, type DashboardInputEvent, type LayerContext } from "../layers";

export class TranscribeLayer implements Layer {
  private mode: "off" | "wakeword" | "full" = "full";
  private status = "Starting transcription...";
  private transcript = "";
  private unsubscribeTranscript: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  start(ctx: LayerContext): void {
    this.unsubscribeTranscript = voiceControlBridge.onTranscript((event) => this.onTranscript(event));
    this.unsubscribeStatus = voiceControlBridge.onStatus((state) => {
      this.status = state.status;
    });
    void ctx.actions.setTranscribeRenderActive(true);
    void Promise.resolve(ctx.actions.startDedicatedVoiceInput("full")).catch((error) => {
      this.status = `Could not start transcription: ${error instanceof Error ? error.message : String(error)}`;
    });
  }

  paint(ctx: LayerContext): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const modeLabel = this.mode === "full" ? "Full" : this.mode === "wakeword" ? "Wakeword" : "Off";
    const text = this.transcript || "Listening...";
    const wrapped = wrapTranscribeText(ctx.font, text, G2_LENS_WIDTH - 64);

    image.drawRect(12, 12, G2_LENS_WIDTH - 24, G2_LENS_HEIGHT - 24, 52);
    image.drawText(ctx.font, 24, 24, "Transcribe", 200);
    image.drawText(ctx.font, G2_LENS_WIDTH - 108, 24, modeLabel, this.mode === "full" ? 220 : 130);
    //image.drawText(ctx.font, 24, 46, truncateTranscribeLine(this.status, 74), 110);
    image.drawText(ctx.font, 24, 46, this.status, 110);

    const firstLine = Math.max(0, wrapped.length - 10);
    for (let index = firstLine; index < wrapped.length; index++) {
      const y = 72 + (index - firstLine) * 16;
      image.drawText(ctx.font, 32, y, wrapped[index]!, 230);
    }

    image.drawText(ctx.font, 24, 252, "Click: mode / Double-click: back", 110);
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    if (event.type === "double-click") {
      this.stop(ctx);
      ctx.stack.pop();
      return;
    }
    if (event.type === "click") {
      this.cycleMode(ctx);
    }
  }

  private cycleMode(ctx: LayerContext): void {
    if (this.mode === "full") {
      this.mode = "wakeword";
      void ctx.actions.startDedicatedVoiceInput("wakeword");
    } else if (this.mode === "wakeword") {
      this.mode = "off";
      void ctx.actions.stopDedicatedVoiceInput();
    } else {
      this.mode = "full";
      void ctx.actions.startDedicatedVoiceInput("full");
    }
  }

  private stop(ctx: LayerContext): void {
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    void ctx.actions.setTranscribeRenderActive(false);
    void ctx.actions.stopDedicatedVoiceInput();
  }

  private onTranscript(event: VoiceTranscriptEvent): void {
    if (event.isFinal) {
      if (this.transcript && !this.transcript.endsWith("\n")) {
        this.transcript = `${this.transcript}\n`;
      }
      return;
    }
    this.transcript = appendTranscriptChunk(this.transcript, event.text);
  }
}

function appendTranscriptChunk(transcript: string, chunk: string): string {
  const trimmed = chunk.replace(/\s+/g, " ").trim();
  if (!trimmed) return transcript;
  if (!transcript || transcript.endsWith("\n") || /^[.,!?;:]/.test(trimmed)) {
    return `${transcript}${trimmed}`;
  }
  return `${transcript} ${trimmed}`;
}

function wrapTranscribeText(font: BdfFont, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.measureText(candidate) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

function truncateTranscribeLine(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}
