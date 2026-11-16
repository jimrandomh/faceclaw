import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { lineStep } from "../../ui/metrics";
import { MicLevelMeter, paintListeningHeader, RECORDING_FAILED_NOTICE } from "../../ui/listening-header";
import { writeTextToDownloads } from "../../native/file-access";
import { voiceControlBridge, type VoiceEventSource, type VoiceReplay } from "../../native/voice-control";
import { Layer, type LayerContext } from "../../ui/layers";
import { type InputEvent } from "../../ui/gestures";
import { formatReplayTime } from "./replay-time";
import { TranscriptModel, TranscriptScroll, transcriptLayout, wrapTranscribeText } from "./transcript-model";

/**
 * Live transcription view. Continuous mic capture is owned by the app wrapper
 * (createTranscribeAppWindow); this layer accumulates the transcript, shows
 * it, and saves it to Downloads from the app menu.
 *
 * Given a replay, it transcribes that recording instead of the microphone:
 * the header shows the position in the recording, a tap pauses and resumes,
 * and each jump leaves its time as a line in the transcript.
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
  private unsubscribeReplay: (() => void) | null = null;
  private readonly source: VoiceEventSource;

  /**
   * `stamp` names the saved transcript, matching the session's audio
   * recording. `replay` is the recording to transcribe in place of the
   * microphone; `replayName` is what to call it.
   */
  constructor(
    private readonly stamp: string = transcriptTimestamp(),
    private readonly replay: VoiceReplay | null = null,
    private readonly replayName = "",
  ) {
    this.source = replay ? replay.events : voiceControlBridge;
    if (replay) this.status = "Opening the recording...";
  }

  /** `isVisible` says whether the window is on screen (the level meter and replay clock repaint only then). */
  start(requestRender: () => void, isVisible: () => boolean): void {
    this.meter.start(requestRender, isVisible, this.source);
    this.unsubscribeTranscript = this.source.onTranscript((event) => {
      this.transcript.accept(event);
      requestRender();
    });
    this.unsubscribePause = this.source.onSpeechPause(() => this.transcript.pause());
    // The current status arrives while subscribing, before the window has a
    // surface to render to; the window paints it when it is first shown.
    let subscribing = true;
    this.unsubscribeStatus = this.source.onStatus((state) => {
      this.status = state.status;
      this.listening = state.listening;
      this.detail = state.detail;
      this.saveNotice = "";
      if (!subscribing) requestRender();
    });
    subscribing = false;
    const replay = this.replay;
    if (replay) {
      let shownSecond = -1;
      let shownState = replay.state;
      this.unsubscribeReplay = replay.onChange((jumpedToMs) => {
        if (jumpedToMs !== undefined) this.transcript.mark(`[${formatReplayTime(jumpedToMs)}]`);
        // The clock ticks in whole seconds; repaint when what it shows changed.
        const second = Math.floor(replay.positionMs / 1000);
        if (jumpedToMs === undefined && second === shownSecond && replay.state === shownState) return;
        shownSecond = second;
        shownState = replay.state;
        if (isVisible()) requestRender();
      });
    }
  }

  /** The header's status for a replay: where it is in the recording, and anything worth saying beside that. */
  private replayStatus(replay: VoiceReplay): string {
    if (replay.state === "failed" || (replay.state === "opening" && replay.durationMs === 0)) return this.status;
    const withHours = replay.durationMs >= 3_600_000;
    const clock = `${formatReplayTime(replay.positionMs, withHours)} / ${formatReplayTime(replay.durationMs, withHours)}`;
    if (replay.state === "paused") return `${clock} · Paused`;
    if (replay.state === "ended") return `${clock} · Finished`;
    // Anything but plain listening is worth showing: the model loading, a provider reconnecting.
    return this.listening ? clock : `${clock} · ${this.status}`;
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const viewport = ctx.stack.getBaseSize();
    const image = new GrayImage(viewport.width, viewport.height, 0);

    const replay = this.replay;
    const status = replay
      ? this.replayStatus(replay)
      : this.source.recordingFailed ? RECORDING_FAILED_NOTICE : this.status;
    const playing = !replay || replay.state === "playing";
    const bodyTop = paintListeningHeader(
      image, font, "Transcribe", this.saveNotice || status, this.listening && playing ? this.meter : null, viewport.padding,
      this.source.recording,
    );
    const step = lineStep(font) + 2;
    const layout = transcriptLayout(viewport, bodyTop, font.lineHeight, step);
    const placeholder = replay ? `Replaying ${this.replayName}` : "Listening...";
    const text = this.transcript.text || (this.listening ? placeholder : this.detail);
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
    if (event.type === "click" && this.replay) {
      this.replay.setPaused(this.replay.state === "playing");
      ctx.actions.requestRender();
      return;
    }
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }

  onRemoved(): void {
    this.meter.stop();
    this.unsubscribeReplay?.();
    this.unsubscribeReplay = null;
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
