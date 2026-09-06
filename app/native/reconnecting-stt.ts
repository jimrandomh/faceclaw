import type { CloudSttClient, CloudSttOptions, CloudSttTranscriptEvent } from "./cloud-stt";
import { SpeechPauseDetector } from "./speech-pause";

// Ten seconds of unsent PCM. Never replay audio already sent: that would
// duplicate words already shown. An extended outage drops the oldest audio.
const MAX_PENDING_BYTES = 16000 * 2 * 10;

/** Owns retries and audio buffering independently of the provider protocol. */
export class ReconnectingSttClient implements CloudSttClient {
  private client: CloudSttClient | null = null;
  private generation = 0;
  private stopped = false;
  private finishing = false;
  private ready = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private finishTimeout: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private latest: CloudSttTranscriptEvent | null = null;
  private readonly pause = new SpeechPauseDetector();

  constructor(
    private readonly create: (options: CloudSttOptions) => CloudSttClient,
    private readonly options: CloudSttOptions,
    private readonly continuous: () => boolean,
  ) {}

  start(): void {
    if (this.stopped || this.client || this.retry !== null) return;
    const generation = ++this.generation;
    const current = () => !this.stopped && generation === this.generation;
    this.client = this.create({
      ...this.options,
      onReady: () => {
        if (!current()) return;
        this.ready = true;
        const chunks = this.pending;
        this.pending = [];
        this.pendingBytes = 0;
        for (const chunk of chunks) this.acceptPcm(chunk);
        if (this.finishing) this.client?.finish();
      },
      onTranscript: (event) => {
        if (!current()) return;
        // A handshake alone can immediately be followed by another failure.
        this.attempt = 0;
        this.latest = event.isFinal ? null : event;
        this.options.onTranscript(event);
      },
      onStatus: (status) => { if (current()) this.options.onStatus(status); },
      onError: (message) => {
        if (!current()) return;
        this.stop();
        this.options.onError(message);
      },
      onDisconnected: (message) => {
        if (current()) this.disconnected(message);
      },
    });
    try {
      this.client.start();
    } catch (error) {
      this.disconnected(`Transcription connection failed: ${String(error)}`);
    }
  }

  acceptPcm(pcm: Uint8Array): void {
    if (this.stopped || !pcm.length) return;
    if (!this.ready) {
      const copy = pcm.slice(-MAX_PENDING_BYTES);
      this.pending.push(copy);
      this.pendingBytes += copy.length;
      while (this.pendingBytes > MAX_PENDING_BYTES) this.pendingBytes -= this.pending.shift()!.length;
      return;
    }
    this.client?.acceptPcm(pcm);
    // A rejected send synchronously reports disconnection. Keep that packet
    // with the unsent audio instead of losing it at the outage boundary.
    if (!this.ready && !this.stopped) this.acceptPcm(pcm);
    if (this.ready && !this.finishing && this.continuous() && this.pause.accept(pcm)) this.client?.commitSegment?.();
  }

  finish(): void {
    if (this.stopped || this.finishing) return;
    this.finishing = true;
    // Releasing the last mic holder must not leave a reconnect loop alive.
    if (this.retry !== null) {
      this.preservePartial();
      this.stop();
      return;
    }
    this.finishTimeout = setTimeout(() => this.stop(), 5000);
    if (this.ready) this.client?.finish();
  }

  stop(): void {
    this.stopped = true;
    ++this.generation;
    if (this.retry !== null) clearTimeout(this.retry);
    if (this.finishTimeout !== null) clearTimeout(this.finishTimeout);
    this.retry = this.finishTimeout = null;
    this.client?.stop();
    this.client = null;
    this.ready = false;
    this.pending = [];
    this.pendingBytes = 0;
    this.latest = null;
  }

  private preservePartial(): void {
    if (this.latest?.text.trim()) this.options.onTranscript({ ...this.latest, isFinal: true });
    this.latest = null;
  }

  private disconnected(message: string): void {
    if (this.stopped) return;
    ++this.generation; // Ignore late finals / closes from the abandoned socket.
    this.ready = false;
    this.client?.stop();
    this.client = null;
    this.pause.reset();
    this.preservePartial();
    if (this.stopped) return; // A transcript listener can release capture.
    if (/\b(401|402|403)\b/.test(message)) {
      this.stop();
      this.options.onError(message);
      return;
    }
    if (this.finishing) {
      this.stop();
      return;
    }
    const delay = Math.min(1000 * 2 ** Math.min(this.attempt++, 5), 30000);
    this.options.onStatus(`Connection lost. Reconnecting in ${delay / 1000}s...`);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.start();
    }, delay);
  }
}
