import { Utils } from "@nativescript/core";

import { CaptureRestartBackoff } from "./capture-restart";
import { type CloudSttTranscriptEvent, CloudSttClient, toJavaBytes } from "./cloud-stt";
import { createCloudSttClient, transcriptionKey } from "./cloud-stt-provider";
import { newRecordingPath } from "./mic-recording";
import { SpeechPauseDetector } from "./speech-pause";
import { toUint8Array } from "../util/array-util";
import { pcmLevel } from "../util/audio-level";

declare const com: any;

export type VoiceControlState = {
  /** One-line state of the capture: progress, "Listening...", or an error. */
  status: string;
  /**
   * Whether audio is actually being captured and transcribed right now. False
   * while the mic is starting, while the phone is showing the permission
   * prompt, and after an error, so a dialog must not claim to be listening.
   */
  listening: boolean;
  /**
   * Longer guidance to show in place of the (still empty) transcript, e.g.
   * what the user has to do on the phone. Empty when there is nothing to say.
   */
  detail: string;
};

// "whisper" (no "onboard-" prefix) is the OpenAI CLOUD provider (gpt-realtime-whisper,
// see openai-stt.ts) -- an unfortunate pre-existing name collision with the model
// family, not with "onboard-whisper" below, which is the on-device sherpa-onnx
// Whisper backend added alongside "onboard" (Moonshine). Kept as-is rather than
// renamed, since it's a persisted settings value on real installs already.
// "whisper-server" is a self-hosted OpenAI-compatible Whisper over HTTP
// (whisper-server-stt.ts).
export type VoiceProviderKind = "onboard" | "onboard-whisper" | "elevenlabs" | "whisper" | "soniox" | "whisper-server";

export type VoiceTranscriptEvent = CloudSttTranscriptEvent & {
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
  whisperServerUrl?: string;
  whisperServerModel?: string;
  whisperServerApiKey?: string;
  /** Spoken language for cloud providers (see VoiceProviderSelection.language). */
  language?: string;
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
  /**
   * Capture from the temples' own microphones (the custom firmware's
   * mic_control stream) instead of the glasses' mixed stream. Each temple
   * streams its microphones on its own link and clock; the phone mixes them
   * into the mono feed that is transcribed. Null/absent keeps the mixed
   * stream; ignored with usePhoneMic.
   */
  micArray?: MicArrayCapture | null;
  /**
   * Play this recording (a .mka file from Save Recording) in real time in
   * place of any microphone. The capture needs no glasses, and ends by
   * itself when the recording does.
   */
  replay?: { path: string; startMs: number } | null;
  /** What the caller knows of the capture, for the description stored in a recording of it. */
  captureInfo?: Record<string, unknown>;
};

export type MicArrayCapture = {
  /** The mic_control CONFIGURE record both temples are armed with (see mic-protocol.ts). */
  configure: Uint8Array;
};

/** Progress of a capture that replays a recording; positions are ms into it. */
export type VoiceReplayEvent = {
  /**
   * `start` once the file is open, `position` about once per second played,
   * `seek` when a jump took effect, `end` when the recording ran out, and
   * `error` when it could not be opened (the status says why).
   */
  kind: "start" | "position" | "seek" | "end" | "error";
  positionMs: number;
  durationMs: number;
};

/** What a listening view (Transcribe, Translate) takes from a capture: the microphone's, or a replay's. */
export type VoiceEventSource = {
  onStatus(listener: (state: VoiceControlState) => void): () => void;
  onTranscript(listener: (event: VoiceTranscriptEvent) => void): () => void;
  onSpeechPause(listener: () => void): () => void;
  onMicLevel(listener: (level: number) => void): () => void;
  readonly recording: boolean;
  readonly recordingFailed: boolean;
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
  private readonly speechPauseListeners = new Set<() => void>();
  private readonly speechPause = new SpeechPauseDetector();
  private readonly speechEndListeners = new Set<() => void>();
  private controller: any = null;
  private listenerProxy: any = null;
  private status = "Voice control stopped.";
  private listening = false;
  private detail = "";
  private started = false;
  private nativeCaptureFinished: Promise<void> = Promise.resolve();
  private nextNativeCaptureId = 1;
  private readonly nativeCaptureResolvers = new Map<number, () => void>();
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
  // What the running STT stream captures from and transcribes with
  // (streamKey); a holder asking for something else restarts the stream
  // rather than sharing it.
  private streamProvider: string | null = null;
  // The options of the running stream, for the description of a recording of it.
  private streamOptions: PushToTalkOptions | null = null;
  private readonly replayListeners = new Set<(event: VoiceReplayEvent) => void>();
  // Raw-PCM tap (EvenHub mic apps, the Microphones app): when active, the
  // controller runs in the decode-only "cloud" mode and every decoded PCM
  // frame is broadcast to these listeners. STT capture preempts it — a live
  // assistant/transcribe session owns the single G2 mic and the raw tap is
  // stopped for its duration.
  private readonly rawPcmListeners = new Set<RawPcmListener>();
  private readonly frameMetaListeners = new Set<FrameMetaListener>();
  private readonly micLevelListeners = new Set<(level: number) => void>();
  private rawActive = false;
  // Who wants the raw tap. It runs while any owner does, so one owner letting
  // go (an EvenHub app backgrounding) doesn't silence another.
  private readonly rawOwners = new Set<string>();
  // Set when the current capture session runs "my voice only" verification;
  // a non-wearer verdict arrives just before the final transcript and makes
  // the bridge swallow it.
  private verificationActive = false;
  private verificationRejected = false;
  // Continuous captures' audio goes to Downloads/<recordingName>.mka while it is
  // set: every source's chunks as they arrive, before any processing, written
  // by the controller. The file outlives a capture, so a restarted one keeps
  // adding to it, and it is created by the first audio, so a failed start
  // leaves no file.
  private recordingName = "";
  // The file is open in the controller.
  private recordingOpen = false;
  // The file could not be created: one attempt per recording, not one per packet.
  private recordingFailure = false;
  private readonly recordingListeners = new Set<() => void>();
  // The native capture this bridge started and has not stopped (0: none). One
  // that reports it stopped while it is still this one ended by itself: the
  // glasses refused or dropped the mic, the model is missing, the worker threw.
  private liveCaptureId = 0;
  // Pending restart of a capture that ended by itself; see handleCaptureDied.
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly restartBackoff = new CaptureRestartBackoff();
  private restartOptions: (() => PushToTalkOptions | null) | null = null;
  // The session the raw tap last ran on, for restarting it.
  private rawCommunicator: any = null;

  onStatus(listener: (state: VoiceControlState) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.state());
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

  /** Pauses in on-device recognition, for Transcribe's presentation only. */
  onSpeechPause(listener: () => void): () => void {
    this.speechPauseListeners.add(listener);
    return () => this.speechPauseListeners.delete(listener);
  }

  /**
   * The capture is blocked on the phone's system microphone-permission
   * prompt. Reported by the controller before it asks Android, so the dialog
   * on the glasses can send the user to the phone instead of claiming to
   * listen; the next status (from the capture start, or reportPermissionDenied)
   * replaces it.
   */
  reportPermissionPrompt(): void {
    this.setStatus(
      "Waiting for microphone permission...",
      "Allow microphone access in the prompt on your phone.",
    );
  }

  /** The user declined the microphone permission (or the prompt could not be shown). */
  reportPermissionDenied(): void {
    this.setStatus(
      "Microphone access denied.",
      "Enable the microphone for Faceclaw in the phone's app settings, then try again.",
    );
  }

  /**
   * Capture could not be started for a reason other than a denied permission.
   * Without this the dialog keeps showing the idle "Voice control stopped."
   */
  reportStartFailed(reason: string): void {
    this.setStatus("Voice input couldn't start.", reason);
  }

  /**
   * Where a held capture that ended by itself gets the options to start again
   * with: the current connection and settings, or null while there is nothing
   * to capture from. Without one it restarts with the options it last had.
   */
  setRestartOptions(provider: (() => PushToTalkOptions | null) | null): void {
    this.restartOptions = provider;
  }

  /** Begin push-to-talk capture (momentary; released with stopPushToTalk). */
  startPushToTalk(options: PushToTalkOptions): void {
    this.acquireCapture("ptt", options);
  }

  /** End push-to-talk: for cloud, commit for a final result if it was the last holder. */
  stopPushToTalk(): Promise<void> | void {
    // Shared continuous capture keeps running; cloud providers finalize via
    // their own callbacks. Only a stopped native recognizer must be awaited.
    const finished = !this.cloudClient && this.captureHolders.has("ptt") && this.captureHolders.size === 1
      ? this.nativeCaptureFinished : undefined;
    this.releaseCapture("ptt", true);
    return finished;
  }

  /**
   * The voice dialog went away. Nothing to do here: its stop already released
   * the capture, and a commit still awaiting its final ends by itself. (iOS
   * has a drain of its own to cancel.)
   */
  cancelPushToTalk(): void {}

  /** Begin continuous capture (Transcribe): the mic stays on until released. */
  startContinuousCapture(options: PushToTalkOptions): void {
    this.acquireCapture("continuous", options);
  }

  stopContinuousCapture(): void {
    this.releaseCapture("continuous", false);
  }

  /**
   * Restart the running continuous capture when it transcribes with another
   * provider than `options` asks for (a window that needs a multilingual one
   * opened or closed), keeping every holder on the new stream. A parked
   * capture is left alone: it takes the options when it resumes.
   */
  retargetContinuousCapture(options: PushToTalkOptions): void {
    if (!this.captureHolders.has("continuous") || !this.micIsLive()) return;
    this.acquireCapture("continuous", options);
  }

  /**
   * End the continuous capture as an utterance: stop it and have the
   * transcript of its last audio come as a final. For a capture whose audio
   * ran out by itself (a replay).
   */
  finishContinuousCapture(): void {
    this.releaseCapture("continuous", true);
  }

  /** Progress of a capture that replays a recording (PushToTalkOptions.replay). */
  onReplay(listener: (event: VoiceReplayEvent) => void): () => void {
    this.replayListeners.add(listener);
    return () => this.replayListeners.delete(listener);
  }

  /** Continue the running replay from `positionMs` into its recording. */
  seekReplay(positionMs: number): void {
    this.controller?.seekReplay(Math.max(0, Math.round(positionMs)));
  }

  /** Hold the running replay where it is, or let it go on. */
  setReplayPaused(paused: boolean): void {
    this.controller?.setReplayPaused(paused);
  }

  /** Whether a capture is running and still has audio coming (a replay stops being so at its end). */
  isCaptureLive(): boolean {
    return this.micIsLive();
  }

  /**
   * Record continuous captures' audio to Downloads/<name>.mka, across restarts,
   * until called with another name or "".
   */
  recordTo(name: string): void {
    if (name === this.recordingName) return;
    this.closeRecording();
    this.setRecording(name, false);
  }

  private closeRecording(): void {
    if (!this.recordingOpen) return;
    this.recordingOpen = false;
    try {
      this.controller?.stopRecording();
    } catch (error) {
      console.warn(`Voice: closing the recording failed: ${error}`);
    }
  }

  /** Whether continuous captures' audio is being saved (see recordTo). */
  get recording(): boolean {
    return this.recordingName !== "" && !this.recordingFailure;
  }

  /** Whether the recording asked for could not be saved (its file could not be created). */
  get recordingFailed(): boolean {
    return this.recordingFailure;
  }

  /** `recording` or `recordingFailed` changed. */
  onRecordingChange(listener: () => void): () => void {
    this.recordingListeners.add(listener);
    return () => this.recordingListeners.delete(listener);
  }

  private setRecording(name: string, failed: boolean): void {
    const wasRecording = this.recording;
    const hadFailed = this.recordingFailure;
    this.recordingName = name;
    this.recordingFailure = failed;
    if (wasRecording === this.recording && hadFailed === failed) return;
    for (const listener of Array.from(this.recordingListeners)) listener();
  }

  /**
   * Audio arrived for a continuous capture: open the recording asked for, if
   * it isn't open yet. The controller writes it from then on, as the audio
   * arrives on its own thread.
   */
  private ensureRecording(): void {
    if (!this.recording || this.recordingOpen) return;
    const path = newRecordingPath(this.recordingName);
    let opened = false;
    try {
      opened = path !== null && Boolean(this.controller?.startRecording(path, JSON.stringify(this.describeCapture())));
    } catch (error) {
      console.warn(`Voice: could not create the recording: ${error}`);
    }
    if (!opened) {
      this.setRecording(this.recordingName, true);
      return;
    }
    this.recordingOpen = true;
    console.log(`Voice: recording audio to ${path}`);
  }

  /** Only captures a continuous holder has a part in are recorded: push-to-talk on its own is not. */
  private syncRecordingEnabled(): void {
    this.controller?.setRecordingEnabled(this.captureHolders.has("continuous"));
  }

  /** The running capture, as the JSON stored in a recording of it. */
  private describeCapture(): Record<string, unknown> {
    const options = this.streamOptions;
    return {
      recording: this.recordingName,
      startedAt: new Date().toISOString(),
      source: options?.usePhoneMic ? "phone" : "glasses",
      micArray: Boolean(options?.micArray) && !options?.usePhoneMic,
      transcription: { provider: options?.provider ?? "", language: options?.language ?? "" },
      processing: {
        noiseSuppression: Boolean(options?.noiseSuppression),
        beamFilter: options?.beamFilter ?? null,
      },
      ...options?.captureInfo,
    };
  }

  /** Subscribe to decoded raw mic PCM (16 kHz mono S16LE). */
  onRawPcm(listener: RawPcmListener): () => void {
    this.rawPcmListeners.add(listener);
    return () => this.rawPcmListeners.delete(listener);
  }

  /**
   * Subscribe to the mic level (meter position in [0,1], see pcmLevel) of
   * each decoded audio chunk, about every 50 ms, from any capture: STT in
   * every mode, or the raw tap.
   */
  onMicLevel(listener: (level: number) => void): () => void {
    this.micLevelListeners.add(listener);
    return () => this.micLevelListeners.delete(listener);
  }

  /** Subscribe to per-packet firmware DSP metadata (DOA angle + SSR). */
  onFrameMeta(listener: FrameMetaListener): () => void {
    this.frameMetaListeners.add(listener);
    return () => this.frameMetaListeners.delete(listener);
  }

  /**
   * Start the decode-only raw-PCM tap on behalf of `owner`. Fails (returns
   * false) if an STT capture already owns the mic; the owner stays registered
   * and re-tries later (the EvenHub router when eligibility is re-evaluated,
   * the Microphones app from its capture check). Idempotent while already
   * running.
   */
  startRawCapture(options: { communicator: any; owner: string }): boolean {
    if (!global.isAndroid) return false;
    this.rawOwners.add(options.owner);
    return this.startRawTap(options.communicator);
  }

  /** `owner` no longer wants the raw tap; it stops once no owner does. */
  stopRawCapture(owner: string): void {
    this.rawOwners.delete(owner);
    if (this.rawOwners.size === 0) this.endRawTap();
  }

  /**
   * Whether the raw tap is running and its glasses mic enable still holds
   * (or is still coming up). False after an STT preemption or a session drop.
   */
  isRawCaptureLive(): boolean {
    return this.rawActive && this.micIsLive();
  }

  private startRawTap(communicator: any): boolean {
    if (!global.isAndroid) return false;
    if (this.rawActive && this.micIsLive()) return true;
    // An STT holder owns the mic even while its stream waits on a new glasses
    // session; the tap re-tries when the app's eligibility is re-evaluated.
    if (this.captureHolders.size > 0 || this.suspendedHolders.size > 0) return false;
    // A tap left over from a dead session is not something to share.
    if (this.started || this.rawActive) this.teardownCapture();
    this.cancelRestart();
    this.suspendedRaw = false;
    this.rawCommunicator = communicator;
    this.ensureController();
    this.controller?.setCommunicator(communicator);
    // The raw tap is strictly the G2 stream; clear any phone-mic flag a
    // preview-mode capture may have left on the shared controller.
    this.controller?.setUsePhoneMic(false);
    this.controller?.setEndpointing(false);
    this.controller?.setMicArray(null);
    this.controller?.setReplay(null, 0);
    // Raw means raw: the Microphones session (and EvenHub apps) get the
    // unprocessed stream and run their own beam/suppression processing.
    this.controller?.setNoiseSuppression(false);
    this.controller?.setBeamFilter(false, 0, 180);
    this.controller?.clearSpeakerVerification();
    this.cloudClient = null;
    this.rawActive = true;
    // "cloud" mode decodes LC3 to PCM and emits it via onPcm without loading
    // any recognizer; with no cloudClient the frames reach only the raw tap.
    this.startNative("cloud");
    return true;
  }

  private endRawTap(): void {
    this.suspendedRaw = false;
    if (!this.rawActive) return;
    this.rawActive = false;
    this.cancelRestart();
    this.stopNative();
  }

  private acquireCapture(holder: CaptureHolder, options: PushToTalkOptions): void {
    if (!global.isAndroid) return;
    // STT preempts the raw-PCM tap: a live transcription session owns the mic,
    // and an EvenHub app gets no audio for its duration.
    if (this.rawActive) this.endRawTap();
    // Whether the mic is already running is a question about the stream, not
    // about this set: a holder whose capture died with the glasses session
    // (or whose mic enable was refused) is still in it. Trusting the set here
    // let one stale holder silently swallow every later request for the
    // process's lifetime.
    const micLive = this.micIsLive();
    this.suspendedHolders.delete(holder);
    this.captureHolders.add(holder);
    if (micLive && this.streamProvider === streamKey(options)) {
      // Mic already running; the new holder just shares the existing stream
      // (transcripts are already broadcast to its listeners).
      this.syncRecordingEnabled();
      return;
    }
    this.startStream(options);
  }

  /** Start the capture that every current holder shares, in place of whatever was running. */
  private startStream(options: PushToTalkOptions): void {
    // Any leftover capture is dead, or captures or transcribes otherwise than
    // its holders need; drop it before starting the new one.
    if (this.started) this.teardownCapture();
    this.cancelRestart();
    this.streamProvider = streamKey(options);
    this.streamOptions = options;
    this.ensureController();
    this.syncRecordingEnabled();
    // A recording under way carries on into this capture: note what changed.
    if (this.recordingOpen) {
      try {
        this.controller?.noteRecordingEvent(JSON.stringify({ event: "capture", ...this.describeCapture() }));
      } catch (error) {
        console.warn(`Voice: recording event failed: ${error}`);
      }
    }
    this.controller?.setCommunicator(options.communicator);
    this.controller?.setUsePhoneMic(Boolean(options.usePhoneMic));
    this.controller?.setMicArray(
      options.micArray && !options.usePhoneMic && !options.replay ? toJavaBytes(options.micArray.configure) : null,
    );
    this.controller?.setReplay(options.replay?.path ?? null, Math.max(0, Math.round(options.replay?.startMs ?? 0)));
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

    this.speechPause.reset();
    // Replaces whatever the last capture left behind ("Listening...", an
    // error, the permission prompt) until the controller reports progress.
    this.setStatus(options.replay ? "Opening the recording..." : "Starting microphone...");
    // A previous push-to-talk commit may still be awaiting its final result.
    this.cloudClient?.stop();
    const cloudClient = this.createCloudClient(options);
    if (cloudClient) {
      this.cloudClient = cloudClient;
      cloudClient.start();
      // It failed outright: handleCaptureDied has the restart in hand.
      if (this.cloudClient !== cloudClient) return;
      this.startNative("cloud");
      return;
    }

    this.cloudClient = null;
    // Which on-device model to load; a no-op setter for every provider except
    // "onboard-whisper" (FaceclawVoiceController defaults to Moonshine).
    this.controller?.setOnboardModelKind(options.provider === "onboard-whisper" ? "whisper" : "moonshine");
    this.startNative("onboard");
  }

  /** Start the controller on a capture of its own id, so its end can be told from an earlier one's. */
  private startNative(mode: "cloud" | "onboard"): void {
    const captureId = this.nextNativeCaptureId++;
    this.liveCaptureId = captureId;
    this.started = true;
    this.restartBackoff.started(Date.now());
    if (mode === "onboard") {
      this.nativeCaptureFinished = new Promise((resolve) => { this.nativeCaptureResolvers.set(captureId, resolve); });
    }
    this.controller?.start(mode, captureId);
  }

  /** Stop the controller's capture as this bridge's own doing (not a capture that died). */
  private stopNative(): void {
    this.liveCaptureId = 0;
    if (global.isAndroid) this.controller?.stop();
    this.started = false;
  }

  /**
   * The running capture ended without this bridge stopping it: the glasses
   * refused or dropped the mic, the native worker gave up, or the cloud
   * provider reported an error it does not come back from. Whoever holds the
   * capture still wants it, so clear away what is left and start it again
   * after a delay that grows while it keeps failing. Left as it was, the
   * holders would stay registered on a stream that no longer exists, and
   * push-to-talk would join it.
   */
  private handleCaptureDied(): void {
    this.stopNative();
    this.cloudClient?.stop();
    this.cloudClient = null;
    this.streamProvider = null;
    // A replay that ended or could not be opened is not something to retry.
    const sttWanted = this.captureHolders.size > 0 && !this.streamOptions?.replay;
    const rawWanted = this.rawActive && this.rawOwners.size > 0;
    if ((!sttWanted && !rawWanted) || this.restartTimer !== null) return;
    const delay = this.restartBackoff.nextDelay(Date.now());
    console.log(`Voice: capture ended by itself; starting it again in ${delay} ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restartDeadCapture();
    }, delay);
  }

  private restartDeadCapture(): void {
    // Something else brought the mic back in the meantime.
    if (this.started) return;
    if (this.captureHolders.size > 0) {
      const options = this.restartOptions ? this.restartOptions() : this.streamOptions;
      if (!options) {
        // Nothing to capture from right now; look again later.
        this.handleCaptureDied();
        return;
      }
      this.startStream({ ...options, endpointing: this.captureEndpointing });
    } else if (this.rawActive && this.rawOwners.size > 0) {
      this.startRawTap(this.rawCommunicator);
    }
  }

  private cancelRestart(): void {
    if (this.restartTimer === null) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  /**
   * The cloud provider for this session, or null to transcribe on-device.
   * A cloud provider whose API key is missing falls back to on-device rather
   * than failing the capture outright.
   */
  private createCloudClient(options: PushToTalkOptions): CloudSttClient | null {
    const client: CloudSttClient | null = createCloudSttClient(options, {
      onTranscript: (event: CloudSttTranscriptEvent) =>
        this.emitTranscript(event.text, event.isFinal, event),
      onStatus: (status: string) => this.setStatus(status),
      onError: (message: string) => {
        this.setStatus(message);
        // The client has stopped itself. While it is the running capture's,
        // nothing transcribes the audio any more.
        if (client !== null && this.cloudClient === client) this.handleCaptureDied();
      },
    }, () => this.captureHolders.has("continuous"));
    return client;
  }

  private releaseCapture(holder: CaptureHolder, commit: boolean): void {
    // A holder that gives up while its capture is parked must not be resumed
    // by the next session.
    this.suspendedHolders.delete(holder);
    if (!this.captureHolders.delete(holder)) {
      // Never held; still finish a dangling cloud commit if one is pending,
      // but not the client the remaining holders are transcribing with (it
      // would stop itself once the commit's final came).
      if (commit && this.captureHolders.size === 0) this.cloudClient?.finish();
      return;
    }
    this.syncRecordingEnabled();
    if (this.captureHolders.size > 0) {
      // Another holder still wants the mic; keep it running.
      return;
    }
    // Nobody is left to bring a dead capture back for.
    this.cancelRestart();
    this.restartBackoff.reset();
    if (!this.started) {
      this.cloudClient?.finish();
      return;
    }
    // Order matters for cloud: stopping the Java controller flushes any final
    // decode/PCM; then commit so the provider finalizes the transcript.
    this.stopNative();
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
    this.restartBackoff.reset();
    this.syncRecordingEnabled();
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
    this.syncRecordingEnabled();
    this.suspendedRaw = this.rawActive;
    // The next session is a fresh start, not another try at a failing one.
    this.restartBackoff.reset();
    this.teardownCapture();
    if (this.suspendedHolders.size > 0) {
      this.setStatus("Waiting for the glasses...");
    }
  }

  /** Whether a capture is parked waiting for a session to come back. */
  hasSuspendedCapture(): boolean {
    return this.suspendedHolders.size > 0 || this.suspendedRaw;
  }

  /** Whether `holder` holds the mic, including across a session outage. */
  holdsCapture(holder: CaptureHolder): boolean {
    return this.captureHolders.has(holder) || this.suspendedHolders.has(holder);
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
    if (resumeRaw && !holders.length && this.rawOwners.size > 0) {
      this.startRawTap(options.communicator);
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
    this.cancelRestart();
    this.rawActive = false;
    this.streamProvider = null;
    this.streamOptions = null;
    this.stopNative();
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
      onStopped: (captureId: number) => {
        this.nativeCaptureResolvers.get(captureId)?.();
        this.nativeCaptureResolvers.delete(captureId);
        // Not stopped from here, so it ended by itself.
        if (this.liveCaptureId !== 0 && Number(captureId) === this.liveCaptureId) this.handleCaptureDied();
      },
      onPcm: (pcm: any) => {
        const bytes = toUint8Array(pcm);
        this.cloudClient?.acceptPcm(bytes);
        // Push-to-talk on a capture of its own is not recorded.
        if (this.captureHolders.has("continuous")) this.ensureRecording();
        if (!this.cloudClient && this.captureHolders.has("continuous") && this.speechPause.accept(bytes)) {
          for (const listener of this.speechPauseListeners) listener();
        }
        if (this.rawPcmListeners.size > 0) {
          this.rawPcmListeners.forEach((listener) => listener(bytes));
        }
        if (this.micLevelListeners.size > 0) {
          const level = pcmLevel(bytes);
          this.micLevelListeners.forEach((listener) => listener(level));
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
      onReplay: (kind: string, positionMs: number, durationMs: number) => {
        const event = { kind: String(kind) as VoiceReplayEvent["kind"], positionMs: Number(positionMs), durationMs: Number(durationMs) };
        for (const listener of Array.from(this.replayListeners)) listener(event);
      },
    });
    this.controller.setListener(this.listenerProxy);
  }

  private emitTranscript(text: string, isFinal: boolean, metadata?: CloudSttTranscriptEvent): void {
    // "My voice only": a rejected session's final transcript is emptied so
    // nothing downstream (assistant, dictation) acts on another speaker's
    // words. The verification verdict is posted before the final, and cloud
    // finals arrive over the network later still, so the flag is settled.
    if (isFinal && this.verificationActive && this.verificationRejected) {
      text = "";
      metadata = undefined;
    }
    const event = { ...metadata, text, isFinal };
    for (const listener of this.transcriptListeners) {
      listener(event);
    }
  }

  private setStatus(status: string, detail = ""): void {
    this.status = status;
    this.detail = detail;
    // Every "audio is flowing" report — from the Java controller and from the
    // cloud providers — is phrased "Listening..." / "Listening (X)...".
    this.listening = status.startsWith("Listening");
    const state = this.state();
    for (const listener of this.statusListeners) {
      listener(state);
    }
  }

  private state(): VoiceControlState {
    return { status: this.status, listening: this.listening, detail: this.detail };
  }
}

/**
 * What a capture reads and transcribes with. A running capture is shared only
 * by holders asking for the same: the provider and language, the microphones
 * (the mixed stream, or the temples' own under a given configuration), or the
 * recording it replays.
 */
function streamKey(options: PushToTalkOptions): string {
  const source = options.replay
    ? `replay:${options.replay.path}`
    : options.micArray && !options.usePhoneMic
      ? `array:${Array.from(options.micArray.configure).join(",")}`
      : "mixed";
  return `${transcriptionKey(options)}|${source}`;
}

function toJavaFloats(values: Float32Array): any {
  const javaFloats = Array.create("float", values.length);
  for (let i = 0; i < values.length; i++) {
    javaFloats[i] = values[i]!;
  }
  return javaFloats;
}

export const voiceControlBridge = new FaceclawVoiceControlBridge();

export type VoiceReplayState = "opening" | "playing" | "paused" | "ended" | "failed";

/**
 * A recording played back as a capture of its own: transcribed by the same
 * pipeline as the microphone, with the same settings, on a bridge and native
 * controller separate from the microphone's. Nothing here touches the mic,
 * so voice input and a live Transcribe window carry on beside a replay.
 */
export class VoiceReplay {
  private readonly bridge = new FaceclawVoiceControlBridge();
  private readonly listeners = new Set<(jumpedToMs?: number) => void>();
  private readonly offReplay: () => void;
  private position = 0;
  private duration = 0;
  private current: VoiceReplayState = "opening";
  private closed = false;

  /**
   * `options` gives the capture options (provider, keys, processing) each
   * time the replay starts, so a restart picks up changed settings.
   */
  constructor(readonly path: string, private readonly options: () => PushToTalkOptions) {
    this.offReplay = this.bridge.onReplay((event) => this.handle(event));
  }

  /** The replay's status, transcript and level events. */
  get events(): VoiceEventSource {
    return this.bridge;
  }

  /** Milliseconds into the recording. */
  get positionMs(): number {
    return this.position;
  }

  /** The recording's length in ms; 0 until it has been opened. */
  get durationMs(): number {
    return this.duration;
  }

  get state(): VoiceReplayState {
    return this.current;
  }

  /**
   * The position, duration or state changed. `jumpedToMs` is given when
   * playback moved there other than by playing on: a jump, or a start
   * part-way in. It comes after the transcript of what played before.
   */
  onChange(listener: (jumpedToMs?: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Play from `positionMs` into the recording. */
  start(positionMs = 0): void {
    if (this.closed) return;
    this.position = Math.max(0, positionMs);
    this.set("opening");
    this.bridge.startContinuousCapture({
      ...this.options(),
      communicator: null,
      usePhoneMic: false,
      micArray: null,
      replay: { path: this.path, startMs: this.position },
    });
  }

  /** Continue from `positionMs`: a jump while playing, a fresh start once the replay has ended. */
  jumpTo(positionMs: number): void {
    if (this.closed) return;
    const target = Math.max(0, this.duration > 0 ? Math.min(positionMs, this.duration) : positionMs);
    if ((this.current === "playing" || this.current === "paused") && this.bridge.isCaptureLive()) {
      this.bridge.seekReplay(target);
      this.position = target;
      this.notify();
      return;
    }
    this.start(target);
  }

  setPaused(paused: boolean): void {
    if (this.closed || (this.current !== "playing" && this.current !== "paused")) return;
    this.bridge.setReplayPaused(paused);
    this.set(paused ? "paused" : "playing");
  }

  /** Stop for good and release the capture. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.offReplay();
    this.listeners.clear();
    this.bridge.stop();
  }

  private handle(event: VoiceReplayEvent): void {
    this.duration = event.durationMs;
    switch (event.kind) {
      case "start":
        this.position = event.positionMs;
        this.current = "playing";
        this.notify(event.positionMs > 0 ? event.positionMs : undefined);
        return;
      case "seek":
        this.position = event.positionMs;
        this.notify(event.positionMs);
        return;
      case "end":
        this.position = event.durationMs;
        // Its last audio is still to be transcribed (a cloud provider's final).
        this.bridge.finishContinuousCapture();
        this.set("ended");
        return;
      case "error":
        this.set("failed");
        return;
      default:
        this.position = event.positionMs;
        this.notify();
    }
  }

  private set(state: VoiceReplayState): void {
    this.current = state;
    this.notify();
  }

  private notify(jumpedToMs?: number): void {
    for (const listener of Array.from(this.listeners)) listener(jumpedToMs);
  }
}
