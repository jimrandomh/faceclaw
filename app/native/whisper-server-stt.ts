import { CLOUD_STT_SAMPLE_RATE, type CloudSttClient, type CloudSttOptions } from "./cloud-stt";

/**
 * Speech-to-text against a self-hosted OpenAI-compatible Whisper server (vLLM,
 * speaches, LocalAI): batch POST {baseUrl}/audio/transcriptions with a WAV file.
 * Each segment (a push-to-talk utterance, or a Transcribe span ended by a pause)
 * is one request, finalized in audio order; an open segment is re-sent every
 * INTERIM_STEP_BYTES for provisional text. A segment that runs SEGMENT_MAX_BYTES
 * without a pause is cut into requests that still leave as one final. start()
 * lists {baseUrl}/models to check reachability and pick a model when none is
 * configured.
 */

export type WhisperServerConfig = {
  /** OpenAI-style API root, e.g. http://host:8004/v1. */
  baseUrl: string;
  /** Model id to request; empty uses the first one the server lists. */
  model: string;
  /** ISO-639-1 language code; empty lets Whisper detect it. */
  language: string;
};

export type WhisperHttpRequest = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: ArrayBuffer;
  timeoutMs: number;
};
export type WhisperHttpResponse = { status: number; text: string };
export type WhisperHttp = (request: WhisperHttpRequest) => Promise<WhisperHttpResponse>;

const BYTES_PER_SECOND = CLOUD_STT_SAMPLE_RATE * 2;
// Provisional transcripts: first after one second of audio, then every 1.5s.
const INTERIM_MIN_BYTES = BYTES_PER_SECOND;
const INTERIM_STEP_BYTES = BYTES_PER_SECOND * 1.5;
// Steady speech or background noise can keep the pause detector from ever
// ending a span. Such a segment is cut at this length, inside Whisper's 30s
// window and well within FINAL_TIMEOUT_MS, after its quietest chunk among the
// last SPLIT_SEARCH_BYTES so a word is less likely to straddle the cut.
const SEGMENT_MAX_BYTES = BYTES_PER_SECOND * 25;
const SPLIT_SEARCH_BYTES = BYTES_PER_SECOND * 5;
const MODELS_TIMEOUT_MS = 5000;
const INTERIM_TIMEOUT_MS = 10000;
const FINAL_TIMEOUT_MS = 12000;
const FINAL_RETRY_DELAY_MS = 750;
// Whisper invents text ("Thank you.") for silence, so a segment whose loudest
// 50ms frame stays below this RMS is not sent at all. Normal speech on the G2
// mic measures in the thousands; the pause detector's noise floor starts at 220.
const SILENCE_RMS = 300;

/** Time the voice bridges should allow a final transcript before giving up. */
export const WHISPER_SERVER_FINAL_TIMEOUT_MS = FINAL_TIMEOUT_MS * 2 + FINAL_RETRY_DELAY_MS + 2000;

type Segment = {
  chunks: Uint8Array[];
  /** RMS of each chunk. */
  levels: number[];
  bytes: number;
  peakRms: number;
  text: string;
  final: boolean;
  closed: boolean;
  paragraphBreakAfter: boolean;
  /** Emit a final even when empty: the end of push-to-talk needs one. */
  required: boolean;
  /** Cut for length: its final leaves joined with the next segment's. */
  continues: boolean;
  interimInFlight: boolean;
  interimBytes: number;
};

/**
 * The API root from what a user typed: tolerates a trailing slash or the full
 * transcription endpoint, and adds /v1 to a bare host. Empty when unusable.
 */
export function normalizeWhisperServerUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+/i.test(url)) return "";
  url = url.replace(/\/audio\/transcriptions$/i, "");
  if (/^https?:\/\/[^/]+$/i.test(url)) url += "/v1";
  return url;
}

export class WhisperServerSttClient implements CloudSttClient {
  private readonly baseUrl: string;
  private model: string;
  private ready = false;
  private closed = false;
  private readonly segments: Segment[] = [];

  constructor(
    private readonly options: CloudSttOptions,
    private readonly config: WhisperServerConfig,
    private readonly http: WhisperHttp = nativeHttp,
  ) {
    this.baseUrl = normalizeWhisperServerUrl(config.baseUrl);
    this.model = config.model.trim();
  }

  start(): void {
    if (this.closed || this.ready) return;
    if (!this.baseUrl) {
      this.options.onError("Whisper server URL is not a valid http(s) address.");
      return;
    }
    this.options.onStatus("Connecting to Whisper server...");
    this.http({ url: `${this.baseUrl}/models`, method: "GET", headers: this.authHeaders(), timeoutMs: MODELS_TIMEOUT_MS })
      .then((response) => {
        if (this.closed) return;
        if (response.status < 200 || response.status >= 300) {
          this.options.onDisconnected?.(`Whisper server returned ${response.status} for /models.`);
          return;
        }
        if (!this.model) this.model = firstModelId(response.text);
        if (!this.model) {
          this.options.onError("Whisper server lists no models; set the model in Settings > Voice.");
          return;
        }
        this.ready = true;
        this.options.onStatus("Listening (Whisper server)...");
        this.options.onReady?.();
      })
      .catch((error) => {
        if (!this.closed) this.options.onDisconnected?.(`Whisper server unreachable: ${describeError(error)}`);
      });
  }

  /** PCM16LE at 16 kHz, appended to the open segment. */
  acceptPcm(pcm: Uint8Array): void {
    if (this.closed || !pcm.length) return;
    const segment = this.openSegment();
    const level = rms(pcm);
    segment.chunks.push(pcm.slice());
    segment.levels.push(level);
    segment.bytes += pcm.length;
    segment.peakRms = Math.max(segment.peakRms, level);
    if (segment.bytes >= SEGMENT_MAX_BYTES) this.splitSegment(segment);
    this.maybeRequestInterim(this.segments[this.segments.length - 1]!);
  }

  /** A pause in continuous capture: transcribe what came before it. */
  commitSegment(): void {
    this.closeSegment(true, false);
  }

  /** End of the utterance: transcribe the rest and deliver a final. */
  finish(): void {
    this.closeSegment(false, true);
  }

  stop(): void {
    this.closed = true;
    this.segments.length = 0;
  }

  private openSegment(): Segment {
    const last = this.segments[this.segments.length - 1];
    if (last && !last.closed) return last;
    const segment: Segment = {
      chunks: [], levels: [], bytes: 0, peakRms: 0, text: "", final: false, closed: false,
      paragraphBreakAfter: false, required: false, continues: false, interimInFlight: false, interimBytes: 0,
    };
    this.segments.push(segment);
    return segment;
  }

  /**
   * Close the open segment at SEGMENT_MAX_BYTES and carry the audio after its
   * cut into a new one. The cut is after the quietest chunk among the last
   * SPLIT_SEARCH_BYTES; the first chunk always stays.
   */
  private splitSegment(segment: Segment): void {
    let cut = segment.chunks.length - 1;
    let quietest = Infinity;
    let carried = 0;
    for (let i = segment.chunks.length - 1; i > 0 && carried <= SPLIT_SEARCH_BYTES; i--) {
      if (segment.levels[i]! < quietest) {
        quietest = segment.levels[i]!;
        cut = i;
      }
      carried += segment.chunks[i]!.length;
    }
    const chunks = segment.chunks.splice(cut + 1);
    const levels = segment.levels.splice(cut + 1);
    for (const chunk of chunks) segment.bytes -= chunk.length;
    segment.peakRms = peak(segment.levels);
    segment.continues = true;
    this.closeSegment(false, false);
    if (!chunks.length) return;
    const next = this.openSegment();
    next.chunks = chunks;
    next.levels = levels;
    for (const chunk of chunks) next.bytes += chunk.length;
    next.peakRms = peak(levels);
  }

  private closeSegment(paragraphBreakAfter: boolean, required: boolean): void {
    if (this.closed) return;
    const last = this.segments[this.segments.length - 1];
    if (last?.closed && last.continues) {
      // Cut for length with nothing after it yet: this boundary ends its run.
      last.continues = false;
      last.paragraphBreakAfter = paragraphBreakAfter;
      last.required = required;
      if (last.final) this.emit();
      return;
    }
    if (!last || last.closed) {
      // Nothing new since the last boundary. Push-to-talk still needs a final.
      if (required) this.finalize(this.openSegment(), "", paragraphBreakAfter, required);
      return;
    }
    if (last.peakRms < SILENCE_RMS) {
      this.finalize(last, "", paragraphBreakAfter, required);
      return;
    }
    last.closed = true;
    last.paragraphBreakAfter = paragraphBreakAfter;
    last.required = required;
    void this.requestFinal(last, 0);
  }

  private async requestFinal(segment: Segment, attempt: number): Promise<void> {
    try {
      const text = await this.transcribe(segment, segment.bytes, FINAL_TIMEOUT_MS);
      if (!this.closed) this.finalize(segment, text, segment.paragraphBreakAfter, segment.required);
    } catch (error) {
      if (this.closed) return;
      if (error instanceof WhisperAuthError) {
        this.options.onError(error.message);
        return;
      }
      if (attempt === 0) {
        setTimeout(() => { void this.requestFinal(segment, 1); }, FINAL_RETRY_DELAY_MS);
        return;
      }
      // Keep the capture alive and keep whatever the interim pass heard.
      this.options.onStatus(`Whisper server request failed: ${describeError(error)}`);
      this.finalize(segment, segment.text, segment.paragraphBreakAfter, segment.required);
    }
  }

  private maybeRequestInterim(segment: Segment): void {
    if (!this.ready || segment.interimInFlight || segment.closed) return;
    if (segment.bytes < INTERIM_MIN_BYTES) return;
    if (segment.bytes - segment.interimBytes < INTERIM_STEP_BYTES) return;
    if (segment.peakRms < SILENCE_RMS) return;
    segment.interimInFlight = true;
    segment.interimBytes = segment.bytes;
    this.transcribe(segment, segment.bytes, INTERIM_TIMEOUT_MS)
      .then((text) => {
        if (this.closed || segment.final) return;
        segment.text = text;
        this.emit();
      })
      .catch(() => {
        // Provisional only; the final request reports real failures.
      })
      .finally(() => {
        segment.interimInFlight = false;
      });
  }

  private finalize(segment: Segment, text: string, paragraphBreakAfter: boolean, required: boolean): void {
    segment.closed = segment.final = true;
    segment.text = text;
    segment.paragraphBreakAfter = paragraphBreakAfter;
    segment.required = required;
    segment.chunks = [];
    this.emit();
  }

  /**
   * Finals leave in audio order, even when a later request answers first, and
   * segments cut for length leave as one final with the segment that ends
   * their run; whatever is not final yet is shown as one provisional transcript.
   */
  private emit(): void {
    for (;;) {
      let end = 0;
      while (this.segments[end]?.final && this.segments[end]!.continues) end++;
      if (!this.segments[end]?.final) break;
      const run = this.segments.splice(0, end + 1);
      const last = run[run.length - 1]!;
      const text = run.map((segment) => segment.text.trim()).filter(Boolean).join(" ");
      if (!text && !last.required) continue;
      this.options.onTranscript({ text, isFinal: true, paragraphBreakAfter: last.paragraphBreakAfter });
    }
    const pending = this.segments.filter((segment) => segment.text.trim());
    if (!pending.length) return;
    const text = pending.map((segment) => segment.text.trim()).join(" ");
    const transcribeText = pending.map((segment, index) =>
      (index && pending[index - 1]!.paragraphBreakAfter ? "\n" : index ? " " : "") + segment.text.trim(),
    ).join("");
    this.options.onTranscript({ text, transcribeText, isFinal: false });
  }

  private async transcribe(segment: Segment, bytes: number, timeoutMs: number): Promise<string> {
    const fields: Record<string, string> = { model: this.model, response_format: "json", temperature: "0" };
    const language = this.config.language.trim().toLowerCase();
    if (language) fields.language = language;
    const boundary = `faceclaw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const body = multipartBody(boundary, fields, wavFile(segment.chunks, bytes));
    const response = await this.http({
      url: `${this.baseUrl}/audio/transcriptions`,
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
      timeoutMs,
    });
    if (response.status === 401 || response.status === 403) {
      throw new WhisperAuthError(`Whisper server rejected the key (${response.status}).`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 200)}`);
    }
    return parseTranscript(response.text);
  }

  private authHeaders(): Record<string, string> {
    const key = this.options.apiKey.trim();
    return key ? { Authorization: `Bearer ${key}` } : {};
  }
}

class WhisperAuthError extends Error {}

/** The transcript from a JSON response; tolerates servers that send plain text. */
export function parseTranscript(body: string): string {
  const raw = body.trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.text === "string") return parsed.text.trim();
  } catch {
    // Not JSON: a server that answered response_format=text anyway.
  }
  return raw;
}

function firstModelId(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const id = parsed?.data?.[0]?.id;
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

function peak(levels: number[]): number {
  let max = 0;
  for (const level of levels) max = Math.max(max, level);
  return max;
}

/** RMS of a PCM16LE chunk. */
function rms(pcm: Uint8Array): number {
  const count = pcm.length >> 1;
  if (!count) return 0;
  let squares = 0;
  for (let i = 0; i < count; i++) {
    const unsigned = pcm[i * 2]! | (pcm[i * 2 + 1]! << 8);
    const sample = unsigned >= 32768 ? unsigned - 65536 : unsigned;
    squares += sample * sample;
  }
  return Math.sqrt(squares / count);
}

/** The first `bytes` of the chunks as a 16 kHz mono 16-bit WAV file. */
export function wavFile(chunks: Uint8Array[], bytes: number): Uint8Array {
  const length = bytes & ~1;
  const out = new Uint8Array(44 + length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, CLOUD_STT_SAMPLE_RATE, true);
  view.setUint32(28, BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, length, true);
  let offset = 44;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, out.length - offset);
    if (take <= 0) break;
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

/** multipart/form-data with text fields and one WAV part named "file". */
export function multipartBody(boundary: string, fields: Record<string, string>, wav: Uint8Array): ArrayBuffer {
  let head = "";
  for (const [name, value] of Object.entries(fields)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
  const headBytes = utf8(head);
  const tailBytes = utf8(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(headBytes.length + wav.length + tailBytes.length);
  out.set(headBytes, 0);
  out.set(wav, headBytes.length);
  out.set(tailBytes, headBytes.length + wav.length);
  return out.buffer;
}

function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(out);
}

function describeError(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

/**
 * Uploads go through postBinary (on Android NativeScript's HTTP module would
 * copy each body into Java a byte at a time); the model list through
 * NativeScript's HTTP module.
 */
const nativeHttp: WhisperHttp = async (request) => {
  // Required lazily so Node tests can load this module without NativeScript.
  if (request.body) {
    const { postBinary } = require("./binary-http") as typeof import("./binary-http");
    return postBinary(request.url, request.body, request.headers, request.timeoutMs);
  }
  const { withUserAgent } = require("../util/http") as typeof import("../util/http");
  const { request: send } = require("@nativescript/core/http") as typeof import("@nativescript/core/http");
  const response = await send({
    url: request.url,
    method: request.method,
    headers: withUserAgent(request.headers),
    timeout: request.timeoutMs,
  });
  const content = response.content as any;
  let text = "";
  if (content) text = global.isAndroid ? String(content.raw.toString("UTF-8")) : String(content.toString());
  return { status: response.statusCode, text };
};
