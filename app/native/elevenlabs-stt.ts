import { type CloudSttOptions, type CloudSttTranscriptEvent, encodeBase64 } from "./cloud-stt";

declare const com: any;

/**
 * ElevenLabs realtime speech-to-text over WebSocket.
 * https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 *
 * We push 16 kHz signed-16-bit-LE PCM (base64) as it arrives from the G2 mic
 * and, because push-to-talk gives us the utterance boundary, use manual commit:
 * commit=true is sent when the button is released, which finalizes the
 * transcript. Partial transcripts stream in the meantime.
 */

const WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
// The only model the realtime endpoint accepts (verified against the live API;
// it rejects "scribe_v1" with an explicit message naming this one).
const MODEL_ID = "scribe_v2_realtime";
const SAMPLE_RATE = 16000;

export type ElevenLabsTranscriptEvent = CloudSttTranscriptEvent;
export type ElevenLabsSttOptions = CloudSttOptions;

export class ElevenLabsSttClient {
  private ws: any = null;
  private listenerProxy: any = null;
  private open = false;
  private closed = false;
  // PCM that arrived before the socket finished opening; flushed on open.
  private readonly pendingChunks: string[] = [];
  private latestText = "";
  private readonly commits: boolean[] = [];

  constructor(private readonly options: ElevenLabsSttOptions) {}

  start(): void {
    if (this.closed || this.ws) return;
    const url = `${WS_URL}?model_id=${MODEL_ID}&audio_format=pcm_${SAMPLE_RATE}&commit_strategy=manual`;
    this.listenerProxy = new com.faceclaw.app.FaceclawWebSocketListener({
      onOpen: () => {
        if (this.closed) return;
        this.open = true;
        for (const chunk of this.pendingChunks.splice(0)) {
          this.sendChunk(chunk);
        }
        if (!this.closed) this.options.onReady?.();
      },
      onTextMessage: (message: string) => {
        if (!this.closed) this.handleMessage(String(message));
      },
      onClosed: () => {
        this.open = false;
        if (!this.closed) this.options.onDisconnected?.("ElevenLabs connection closed.");
      },
      onFailure: (message: string) => {
        if (this.closed) return;
        this.options.onDisconnected?.(`ElevenLabs connection failed: ${String(message)}`);
      },
    });
    try {
      // The API key rides an xi-api-key header, added by FaceclawWebSocket.
      const key = this.options.apiKey;
      console.log(`[elevenlabs] connecting; apiKey length=${key.length} prefix=${key.slice(0, 4)}`);
      this.ws = new com.faceclaw.app.FaceclawWebSocket(url, this.listenerProxy, "xi-api-key", key);
      this.options.onStatus("Connecting to ElevenLabs...");
    } catch (error) {
      this.options.onDisconnected?.(`ElevenLabs connection failed: ${String((error as Error)?.message ?? error)}`);
    }
  }

  /** Feed PCM (16 kHz signed-16-bit LE). */
  acceptPcm(pcm: Uint8Array): void {
    if (this.closed || pcm.length === 0) return;
    const base64 = encodeBase64(pcm);
    if (this.open) {
      this.sendChunk(base64);
    } else {
      this.pendingChunks.push(base64);
    }
  }

  commitSegment(): void {
    this.commit(true);
  }

  /** End of utterance: flush and commit for a final transcript. */
  finish(): void {
    this.commit(false);
  }

  private commit(paragraphBreakAfter: boolean): void {
    if (this.closed) return;
    this.commits.push(paragraphBreakAfter);
    if (this.open) this.sendChunk("__commit__");
    else this.pendingChunks.push("__commit__");
  }

  stop(): void {
    this.closed = true;
    this.open = false;
    if (this.ws) {
      try {
        this.ws.close(1000, "bye");
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.listenerProxy = null;
    this.pendingChunks.length = 0;
  }

  private sendChunk(base64OrCommit: string): void {
    const commit = base64OrCommit === "__commit__";
    this.trySend(JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: commit ? "" : base64OrCommit,
      commit,
      sample_rate: SAMPLE_RATE,
    }));
  }

  private trySend(message: string): void {
    try {
      if (this.ws?.sendText(message) === false) {
        this.options.onDisconnected?.("ElevenLabs send failed.");
      }
    } catch (error) {
      this.options.onDisconnected?.(`ElevenLabs send failed: ${String(error)}`);
    }
  }

  private handleMessage(text: string): void {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    switch (message?.message_type) {
      case "session_started":
        this.options.onStatus("Listening (ElevenLabs)...");
        return;
      case "partial_transcript":
        this.latestText = String(message.text ?? "");
        this.options.onTranscript({ text: this.latestText, isFinal: false });
        return;
      case "committed_transcript":
        this.latestText = String(message.text ?? this.latestText);
        this.options.onTranscript({ text: this.latestText, isFinal: true, paragraphBreakAfter: this.commits.shift() ?? false });
        this.latestText = "";
        return;
      case "committed_transcript_with_timestamps":
        // The timestamp event follows the plain commit; do not append twice.
        return;
      case "rate_limited":
        this.options.onDisconnected?.("ElevenLabs rate limited.");
        return;
      case "error":
      case "auth_error":
      case "quota_exceeded":
      case "input_error":
        this.options.onError(`ElevenLabs: ${String(message.error ?? message.message_type)}`);
        return;
      default:
        return;
    }
  }
}
