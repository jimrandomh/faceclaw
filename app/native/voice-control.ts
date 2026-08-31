import { Utils } from "@nativescript/core";

import { CloudSttClient } from "./cloud-stt";
import { ElevenLabsSttClient } from "./elevenlabs-stt";
import { OpenAiRealtimeSttClient } from "./openai-stt";
import { SonioxSttClient } from "./soniox-stt";
import { toUint8Array } from "../util/array-util";

declare const com: any;

export type VoiceControlState = {
  status: string;
};

export type VoiceProviderKind = "onboard" | "elevenlabs" | "whisper" | "soniox";

export type VoiceTranscriptEvent = {
  /**
   * Complete best transcript of the current utterance. REPLACE semantics —
   * render as-is, replacing any previous partial. Not a delta.
   */
  text: string;
  isFinal: boolean;
};

export type PushToTalkOptions = {
  /** Native G2 communicator, or null in preview-only mode (see usePhoneMic). */
  communicator: any;
  /**
   * Capture from the phone's own microphone instead of the G2 over BLE.
   * Preview-only mode, where no glasses are connected; everything downstream
   * (providers, endpointing, verification) works the same on either source.
   */
  usePhoneMic?: boolean;
  provider: VoiceProviderKind;
  elevenLabsApiKey: string;
  openAiApiKey: string;
  sonioxApiKey: string;
  saveRecording: boolean;
  /**
   * Watch the mic and fire onSpeechEnd when the speaker stops. For hands-free
   * ("Hey Even") capture, which has no button release to end the utterance.
   * Ignored when the mic is already running for another holder.
   */
  endpointing?: boolean;
  /**
   * "My voice only": verify the captured utterance against the enrolled
   * wearer voice-print, and suppress the final transcript when someone else
   * spoke. wearerEmbedding is the L2-normalized profile centroid.
   */
  speakerVerification?: {
    speakerModelPath: string;
    wearerEmbedding: Float32Array;
    threshold: number;
  };
  /** Spectral noise suppression on the decoded stream (Microphones config). */
  noiseSuppression?: boolean;
  /**
   * Sonic Radar beam gating: only listen to the configured wedge (device
   * frame). Null/absent leaves the mic omnidirectional.
   */
  beamFilter?: { centerDeg: number; halfWidthDeg: number } | null;
};

/** Who currently wants the mic running. */
type CaptureHolder = "ptt" | "continuous";

export type RawPcmListener = (pcm: Uint8Array) => void;

/**
 * Per-packet DSP metadata the glasses firmware appends to each 50 ms audio
 * packet: direction-of-arrival in signed degrees (0 = straight ahead,
 * positive to the wearer's right) and a signal-strength ratio used as a
 * confidence/energy proxy. Computed on the raw stereo capture before the
 * firmware's mono downmix, so it survives even though only mono PCM arrives.
 */
export type MicFrameMeta = { angleDegrees: number; ssr: number };
export type FrameMetaListener = (meta: MicFrameMeta) => void;

export class FaceclawVoiceControlBridge {
  private readonly statusListeners = new Set<(state: VoiceControlState) => void>();
  private readonly transcriptListeners = new Set<(event: VoiceTranscriptEvent) => void>();
  private readonly speechEndListeners = new Set<() => void>();
  private controller: any | null = null;
  private listenerProxy: any | null = null;
  private status = "Voice control stopped.";
  private started = false;
  // The mic is a single shared stream; these are the reasons it is running.
  // The first holder starts capture (choosing the provider); the mic stops
  // when the last one releases. Transcript events broadcast to every
  // listener, so push-to-talk and the Transcribe window both receive text.
  private readonly captureHolders = new Set<CaptureHolder>();
  // Holders whose stream died with the glasses session (transport drop,
  // charging case, EvenHub suspend). They still want the mic, so the next
  // session restarts it for them; see handleSessionEnded/resumeCapture.
  private readonly suspendedHolders = new Set<CaptureHolder>();
  private suspendedRaw = false;
  // Endpointing of the live capture, replayed when it is resumed.
  private captureEndpointing = false;
  // Non-null while a cloud provider owns the transcript; Java only decodes PCM.
  private cloudClient: CloudSttClient | null = null;
  // Raw-PCM tap (EvenHub mic apps): when active, the controller runs in the
  // decode-only "cloud" mode and every decoded PCM frame is broadcast to these
  // listeners. STT capture preempts it — a live assistant/transcribe session
  // owns the single G2 mic and the raw tap is stopped for its duration.
  private readonly rawPcmListeners = new Set<RawPcmListener>();
  private readonly frameMetaListeners = new Set<FrameMetaListener>();
  private rawActive = false;
  // Set when the current capture session runs "my voice only" verification;
  // a non-wearer verdict arrives just before the final transcript and makes
  // the bridge swallow it.
  private verificationActive = false;
  private verificationRejected = false;

  onStatus(listener: (state: VoiceControlState) => void): () => void {
    this.statusListeners.add(listener);
    listener({ status: this.status });
    return () => this.statusListeners.delete(listener);
  }

  onTranscript(listener: (event: VoiceTranscriptEvent) => void): () => void {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
  }

  /**
   * The speaker stopped, in a hands-free session. Only fires when the capture
   * was started with `endpointing: true`.
   */
  onSpeechEnd(listener: () => void): () => void {
    this.speechEndListeners.add(listener);
    return () => this.speechEndListeners.delete(listener);
  }

  /** Begin push-to-talk capture (momentary; released with stopPushToTalk). */
  startPushToTalk(options: PushToTalkOptions): void {
    this.acquireCapture("ptt", options);
  }

  /** End push-to-talk: for cloud, commit for a final result if it was the last holder. */
  stopPushToTalk(): void {
    this.releaseCapture("ptt", true);
  }

  /** Begin continuous capture (Transcribe): the mic stays on until released. */
  startContinuousCapture(options: PushToTalkOptions): void {
    this.acquireCapture("continuous", options);
  }

  stopContinuousCapture(): void {
    this.releaseCapture("continuous", false);
  }

  /** Subscribe to decoded raw mic PCM (16 kHz mono S16LE). */
  onRawPcm(listener: RawPcmListener): () => void {
    this.rawPcmListeners.add(listener);
    return () => this.rawPcmListeners.delete(listener);
  }

  /** Subscribe to per-packet firmware DSP metadata (DOA angle + SSR). */
  onFrameMeta(listener: FrameMetaListener): () => void {
    this.frameMetaListeners.add(listener);
    return () => this.frameMetaListeners.delete(listener);
  }

  /**
   * Start the decode-only raw-PCM tap for an EvenHub mic app. Fails (returns
   * false) if an STT capture already owns the mic; the caller re-tries when its
   * eligibility is re-evaluated. Idempotent while already running.
   */
  startRawCapture(options: { communicator: any }): boolean {
    if (!global.isAndroid) return false;
    if (this.rawActive && this.micIsLive()) return true;
    // An STT holder owns the mic even while its stream waits on a new glasses
    // session; the tap re-tries when the app's eligibility is re-evaluated.
    if (this.captureHolders.size > 0 || this.suspendedHolders.size > 0) return false;
    // A tap left over from a dead session is not something to share.
    if (this.started || this.rawActive) this.teardownCapture();
    this.suspendedRaw = false;
    this.ensureController();
    this.controller?.setCommunicator(options.communicator);
    // The raw tap is strictly the G2 stream; clear any phone-mic flag a
    // preview-mode capture may have left on the shared controller.
    this.controller?.setUsePhoneMic(false);
    this.controller?.setSaveRecordings(false);
    this.controller?.setEndpointing(false);
    // Raw means raw: the Microphones session (and EvenHub apps) get the
    // unprocessed stream and run their own beam/suppression processing.
    this.controller?.setNoiseSuppression(false);
    this.controller?.setBeamFilter(false, 0, 180);
    this.controller?.clearSpeakerVerification();
    this.cloudClient = null;
    this.rawActive = true;
    this.started = true;
    // "cloud" mode decodes LC3 to PCM and emits it via onPcm without loading
    // any recognizer; with no cloudClient the frames reach only the raw tap.
    this.controller?.start("cloud");
    return true;
  }

  stopRawCapture(): void {
    this.suspendedRaw = false;
    if (!this.rawActive) return;
    this.rawActive = false;
    this.started = false;
    if (global.isAndroid) this.controller?.stop();
  }

  private acquireCapture(holder: CaptureHolder, options: PushToTalkOptions): void {
    if (!global.isAndroid) return;
    // STT preempts the raw-PCM tap: a live transcription session owns the mic,
    // and an EvenHub app gets no audio for its duration.
    if (this.rawActive) this.stopRawCapture();
    // Whether the mic is already running is a question about the stream, not
    // about this set: a holder whose capture died with the glasses session
    // (or whose mic enable was refused) is still in it. Trusting the set here
    // let one stale holder silently swallow every later request for the
    // process's lifetime.
    const micLive = this.micIsLive();
    this.suspendedHolders.delete(holder);
    this.captureHolders.add(holder);
    if (micLive) {
      // Mic already running; the new holder just shares the existing stream
      // (transcripts are already broadcast to its listeners).
      return;
    }
    // Any leftover capture is dead; drop it before starting the new one.
    if (this.started) this.teardownCapture();
    this.ensureController();
    this.controller?.setCommunicator(options.communicator);
    this.controller?.setUsePhoneMic(Boolean(options.usePhoneMic));
    this.controller?.setSaveRecordings(options.saveRecording);
    this.controller?.setEndpointing(Boolean(options.endpointing));
    this.captureEndpointing = Boolean(options.endpointing);
    this.controller?.setNoiseSuppression(Boolean(options.noiseSuppression));
    if (options.beamFilter) {
      this.controller?.setBeamFilter(true, Math.round(options.beamFilter.centerDeg), Math.round(options.beamFilter.halfWidthDeg));
    } else {
      this.controller?.setBeamFilter(false, 0, 180);
    }
    this.verificationRejected = false;
    if (options.speakerVerification) {
      this.verificationActive = true;
      this.controller?.setSpeakerVerification(
        options.speakerVerification.speakerModelPath,
        toJavaFloats(options.speakerVerification.wearerEmbedding),
        options.speakerVerification.threshold,
      );
    } else {
      this.verificationActive = false;
      this.controller?.clearSpeakerVerification();
    }

    const cloudClient = this.createCloudClient(options);
    if (cloudClient) {
      this.cloudClient = cloudClient;
      cloudClient.start();
      this.started = true;
      this.controller?.start("cloud");
      return;
    }

    this.cloudClient = null;
    this.started = true;
    this.controller?.start("onboard");
  }

  /**
   * The cloud provider for this session, or null to transcribe on-device.
   * A cloud provider whose API key is missing falls back to on-device rather
   * than failing the capture outright.
   */
  private createCloudClient(options: PushToTalkOptions): CloudSttClient | null {
    if (options.provider === "onboard") return null;
    const sttOptions = {
      apiKey: "",
      onTranscript: (event: { text: string; isFinal: boolean }) =>
        this.emitTranscript(event.text, event.isFinal),
      onStatus: (status: string) => this.setStatus(status),
      onError: (message: string) => this.setStatus(message),
    };
    if (options.provider === "elevenlabs") {
      const apiKey = options.elevenLabsApiKey.trim();
      if (!apiKey) {
        this.setStatus("No ElevenLabs key set; using on-device voice.");
        return null;
      }
      return new ElevenLabsSttClient({ ...sttOptions, apiKey });
    }
    if (options.provider === "soniox") {
      const apiKey = options.sonioxApiKey.trim();
      if (!apiKey) {
        this.setStatus("No Soniox key set; using on-device voice.");
        return null;
      }
      return new SonioxSttClient({ ...sttOptions, apiKey });
    }
    const apiKey = options.openAiApiKey.trim();
    if (!apiKey) {
      this.setStatus("No OpenAI key set; using on-device voice.");
      return null;
    }
    return new OpenAiRealtimeSttClient({ ...sttOptions, apiKey });
  }

  private releaseCapture(holder: CaptureHolder, commit: boolean): void {
    // A holder that gives up while its capture is parked must not be resumed
    // by the next session.
    this.suspendedHolders.delete(holder);
    if (!this.captureHolders.delete(holder)) {
      // Never held; still finish a dangling cloud commit if one is pending.
      if (commit) this.cloudClient?.finish();
      return;
    }
    if (this.captureHolders.size > 0) {
      // Another holder still wants the mic; keep it running.
      return;
    }
    if (!this.started) {
      this.cloudClient?.finish();
      return;
    }
    // Order matters for cloud: stopping the Java controller flushes any final
    // decode/PCM; then commit so the provider finalizes the transcript.
    this.controller?.stop();
    this.started = false;
    if (commit) {
      this.cloudClient?.finish();
    } else {
      this.cloudClient?.stop();
      this.cloudClient = null;
    }
  }

  stop(): void {
    this.captureHolders.clear();
    this.suspendedHolders.clear();
    this.suspendedRaw = false;
    this.teardownCapture();
    this.setStatus("Voice control stopped.");
  }

  /**
   * The glasses session ended under a live capture (transport drop, charging
   * case, EvenHub suspend). Its mic enable did not survive, so drop the local
   * capture state — leaving it in place would make the holder set claim a
   * stream that no longer exists — and remember who was holding so
   * resumeCapture() can bring the mic back on the next session.
   */
  handleSessionEnded(): void {
    if (this.captureHolders.size === 0 && !this.started && !this.rawActive) return;
    for (const holder of this.captureHolders) {
      this.suspendedHolders.add(holder);
    }
    this.captureHolders.clear();
    this.suspendedRaw = this.rawActive;
    this.teardownCapture();
    if (this.suspendedHolders.size > 0) {
      this.setStatus("Waiting for the glasses...");
    }
  }

  /** Whether a capture is parked waiting for a session to come back. */
  hasSuspendedCapture(): boolean {
    return this.suspendedHolders.size > 0 || this.suspendedRaw;
  }

  /** Whether anyone holds the mic, including across a session outage. */
  isCaptureHeld(): boolean {
    return this.captureHolders.size > 0 || this.suspendedHolders.size > 0;
  }

  /**
   * A fresh glasses session is ready (its display path warmed up, so a mic
   * enable will be accepted): restart the mic for every holder that was
   * capturing when the last session ended. Mic permission was granted for the
   * original capture and cannot be revoked without restarting the process, so
   * this does not ask again.
   */
  resumeCapture(options: Omit<PushToTalkOptions, "endpointing">): void {
    const holders = Array.from(this.suspendedHolders);
    const resumeRaw = this.suspendedRaw;
    this.suspendedHolders.clear();
    this.suspendedRaw = false;
    for (const holder of holders) {
      this.acquireCapture(holder, { ...options, endpointing: this.captureEndpointing });
    }
    if (resumeRaw && !holders.length) {
      this.startRawCapture({ communicator: options.communicator });
    }
  }

  /**
   * Whether the glasses mic is actually streaming. The holder set and
   * `started` are phone-side bookkeeping; the enable itself lives in the
   * glasses session, so the controller (via the communicator) is the only
   * authority on whether audio is still flowing.
   */
  private micIsLive(): boolean {
    if (!global.isAndroid || !this.started) return false;
    return Boolean(this.controller?.isCapturing());
  }

  /** Stop the native capture and any cloud client; leaves holders alone. */
  private teardownCapture(): void {
    this.rawActive = false;
    if (global.isAndroid) {
      this.controller?.stop();
    }
    this.started = false;
    this.cloudClient?.stop();
    this.cloudClient = null;
  }

  private ensureController(): void {
    if (!global.isAndroid || this.controller) return;
    const context = Utils.android.getApplicationContext();
    if (!context) {
      throw new Error("Android application context unavailable");
    }
    this.controller = new com.faceclaw.app.FaceclawVoiceController(context);
    this.listenerProxy = new com.faceclaw.app.FaceclawVoiceControllerListener({
      onStatus: (status: string) => {
        // The raw tap runs silently; its "Listening (cloud)..." chatter must
        // not surface on the glasses voice status.
        if (this.rawActive) return;
        this.setStatus(String(status));
      },
      onTranscript: (text: string, isFinal: boolean) => {
        this.emitTranscript(String(text), Boolean(isFinal));
      },
      onPcm: (pcm: any) => {
        const bytes = toUint8Array(pcm);
        this.cloudClient?.acceptPcm(bytes);
        if (this.rawPcmListeners.size > 0) {
          this.rawPcmListeners.forEach((listener) => listener(bytes));
        }
      },
      onFrameMeta: (angleDegrees: number, ssr: number) => {
        if (this.frameMetaListeners.size === 0) return;
        const meta = { angleDegrees: Number(angleDegrees), ssr: Number(ssr) };
        this.frameMetaListeners.forEach((listener) => listener(meta));
      },
      onSpeechEnd: () => {
        for (const listener of this.speechEndListeners) {
          listener();
        }
      },
      onSpeakerVerified: (isWearer: boolean, similarity: number) => {
        if (!this.verificationActive) return;
        this.verificationRejected = !isWearer;
        if (!isWearer) {
          this.setStatus(
            `Ignored — not your enrolled voice (match ${Math.round(Number(similarity) * 100)}%).`,
          );
        }
      },
    });
    this.controller.setListener(this.listenerProxy);
  }

  private emitTranscript(text: string, isFinal: boolean): void {
    // "My voice only": a rejected session's final transcript is emptied so
    // nothing downstream (assistant, dictation) acts on another speaker's
    // words. The verification verdict is posted before the final, and cloud
    // finals arrive over the network later still, so the flag is settled.
    if (isFinal && this.verificationActive && this.verificationRejected) {
      text = "";
    }
    const event = { text, isFinal };
    for (const listener of this.transcriptListeners) {
      listener(event);
    }
  }

  private setStatus(status: string): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener({ status });
    }
  }
}

function toJavaFloats(values: Float32Array): any {
  const javaFloats = Array.create("float", values.length);
  for (let i = 0; i < values.length; i++) {
    javaFloats[i] = values[i]!;
  }
  return javaFloats;
}

export const voiceControlBridge = new FaceclawVoiceControlBridge();
