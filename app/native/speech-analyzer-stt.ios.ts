import { CLOUD_STT_SAMPLE_RATE, type CloudSttClient, type CloudSttOptions } from "./cloud-stt";
import { ReconnectingSttClient } from "./reconnecting-stt";
import { TRANSCRIPT_PAUSE_MS } from "./speech-pause";

declare const FaceclawSpeechAnalyzer: any;

/**
 * How long finish() waits for the last results: the model only has to settle
 * the few seconds of audio it hadn't finalized yet.
 */
export const SPEECH_ANALYZER_FINAL_TIMEOUT_MS = 10000;

/**
 * A pause is detected TRANSCRIPT_PAUSE_MS after the last loud audio. A final
 * whose last word ends within this much before that (the model's word ends
 * against the detector's level threshold) leaves nothing before the pause
 * unfinalized, so its paragraph is complete.
 */
const PARAGRAPH_TAIL_S = TRANSCRIPT_PAUSE_MS / 1000 + 0.25;

type AnalyzerEvent = {
  kind: string;
  message?: string;
  locale?: string;
  text?: string;
  final?: boolean;
  start?: number | null;
  end?: number | null;
  speechEnd?: number | null;
};

/** Whether Apple's SpeechAnalyzer (iOS 26+, supported hardware) can run continuous capture. */
export function speechAnalyzerSupported(): boolean {
  try {
    return typeof FaceclawSpeechAnalyzer !== "undefined" && Boolean(FaceclawSpeechAnalyzer.isSupported());
  } catch {
    return false;
  }
}

/**
 * On-device long-form transcription for continuous capture, wrapped like a
 * cloud provider: it buffers audio until the model is ready (downloading it on
 * first use) and gets pause commits.
 */
export function createSpeechAnalyzerClient(
  options: Omit<CloudSttOptions, "apiKey">,
  continuous: () => boolean,
): ReconnectingSttClient {
  return new ReconnectingSttClient(
    (clientOptions) => new SpeechAnalyzerSttClient(clientOptions),
    { ...options, apiKey: "", language: (options.language ?? "").trim() },
    continuous,
    SPEECH_ANALYZER_FINAL_TIMEOUT_MS,
  );
}

/**
 * Transcribes PCM with FaceclawSpeechAnalyzer (FaceclawSpeechAnalyzer.swift).
 * The model finalizes text in its own pieces, a few seconds behind, and can't
 * be made to settle at a pause; this gathers its pieces into paragraphs ended
 * by pauses, like the cloud providers' segments. A paragraph is shown as
 * provisional text and sent as one final (paragraphBreakAfter) once a final
 * reaches its pause, and the last one as a plain final when the audio ends.
 *
 * Only finals place breaks, by when their last word ends (the model's
 * word-end times are accurate; first words' starts reach back into the
 * silence before them, and volatile results only carry the range of all audio
 * not finalized yet).
 */
export class SpeechAnalyzerSttClient implements CloudSttClient {
  private native: any = null;
  private samples = 0;
  private finishing = false;
  // Audio times (s) of pauses whose paragraph hasn't ended yet.
  private pauses: number[] = [];
  // Finalized text since the last paragraph break, when its last word ends,
  // and the model's provisional rest.
  private paragraph: string[] = [];
  private paragraphEnd: number | null = null;
  private volatile = "";

  constructor(private readonly options: CloudSttOptions) {}

  start(): void {
    if (this.native) return;
    const native = FaceclawSpeechAnalyzer.new();
    native.eventHandler = (json: string) => {
      if (this.native === native) this.receive(JSON.parse(json));
    };
    this.native = native;
    native.startWithLanguage(this.options.language ?? "");
  }

  acceptPcm(pcm: Uint8Array): void {
    if (!this.native || this.finishing || !pcm.length) return;
    this.samples += pcm.length >> 1;
    const copy = pcm.slice();
    this.native.acceptPcm(NSData.dataWithBytesLength(interop.handleof(copy.buffer), copy.byteLength));
  }

  /** A pause: it ends the paragraph once the words before it are final. */
  commitSegment(): void {
    if (!this.native || this.finishing) return;
    this.pauses.push(this.samples / CLOUD_STT_SAMPLE_RATE);
    if (this.endCompleteParagraph() && this.volatile) this.options.onTranscript({ text: this.liveText(), isFinal: false });
  }

  finish(): void {
    if (!this.native || this.finishing) return;
    this.finishing = true;
    this.native.finish();
  }

  stop(): void {
    const native = this.native;
    this.native = null;
    native?.cancel();
  }

  private receive(event: AnalyzerEvent): void {
    switch (event.kind) {
      case "status":
        this.options.onStatus(event.message ?? "");
        break;
      case "ready":
        this.options.onStatus("Listening (on-device)...");
        this.options.onReady?.();
        break;
      case "transcript":
        this.transcript(event);
        break;
      case "finished": {
        const text = this.liveText();
        this.paragraph = [];
        this.volatile = "";
        this.stop();
        this.options.onTranscript({ text, isFinal: true });
        break;
      }
      case "error":
        this.stop();
        this.options.onError(event.message ?? "On-device transcription failed.");
        break;
    }
  }

  private transcript(event: AnalyzerEvent): void {
    const text = (event.text ?? "").trim();
    let ended = false;
    if (!event.final) {
      this.volatile = text;
    } else {
      this.volatile = "";
      if (text) {
        const end = event.speechEnd ?? event.end ?? null;
        // Words ending after a pause come after it. (One whose words run
        // across it, if the model didn't split there, breaks a little early.)
        if (end !== null && this.pauses.some((pause) => end > pause)) {
          this.pauses = this.pauses.filter((pause) => pause >= end);
          this.endParagraph();
        }
        this.paragraph.push(text);
        this.paragraphEnd = end;
        ended = this.endCompleteParagraph();
      }
    }
    // The paragraph's final already cleared the provisional text.
    if (!ended || this.volatile) this.options.onTranscript({ text: this.liveText(), isFinal: false });
  }

  /** End the paragraph if its last word ends just before a pause. */
  private endCompleteParagraph(): boolean {
    const end = this.paragraphEnd;
    if (!this.paragraph.length || end === null) return false;
    const reached = (pause: number) => end >= pause - PARAGRAPH_TAIL_S;
    if (!this.pauses.some(reached)) return false;
    this.pauses = this.pauses.filter((pause) => !reached(pause));
    this.endParagraph();
    return true;
  }

  private endParagraph(): void {
    const text = this.paragraph.join(" ");
    this.paragraph = [];
    this.paragraphEnd = null;
    if (text) this.options.onTranscript({ text, isFinal: true, paragraphBreakAfter: true });
  }

  private liveText(): string {
    return [...this.paragraph, this.volatile].filter(Boolean).join(" ");
  }
}
