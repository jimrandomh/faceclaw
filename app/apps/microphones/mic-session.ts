import { Utils } from "@nativescript/core";

import { addCompassListener, setCompassEnabled } from "../../native/compass";
import { encodeBase64, toJavaBytes } from "../../native/cloud-stt";
import { toUint8Array } from "../../util/array-util";
import { voiceControlBridge } from "../../native/voice-control";
import { voiceActivity } from "../../ui/shell/voice-activity";
import { onSettingsStoreChanged } from "../../native/settings-store";
import { isAsrModelReady } from "../../native/asr-model";
import {
  TempleAudioPipeline,
  angleInArc,
  deviceToWorld,
  fuseBearings,
  steerWorldToDevice,
  type HeadOrientation,
} from "./dsp";
import { micArrayController, micControlSupported, loadMicConfig, saveMicConfig } from "./mic-control";
import { CaptionClock } from "./caption-clock";
import { micModelPath } from "./mic-models";
import {
  MIC_CHANNEL_KEYS,
  decodeMicStreamFrame,
  isStockAudioPacket,
  micChannelKey,
  micChannelLabel,
  splitInterleavedPcm16,
  templeActive,
  type MicChannelKey,
  type MicConfig,
  type MicSide,
} from "./mic-protocol";
import {
  clearSpeaking,
  normalizeDeg,
  placeDotForUtterance,
  pruneDots,
  smoothAngleDeg,
  trackSpeakingDot,
  type SpeakerDot,
} from "./radar-dots";
import {
  ancEnabledSetting,
  beamFilterSetting,
  captionsEnabledSetting,
  captionsRetentionSetting,
  recordingsRetentionSetting,
  retentionCutoffMs,
  saveCaptionsSetting,
  saveRecordingsSetting,
  translateEnabledSetting,
  wearerCommandsOnlySetting,
} from "./mic-settings";
import {
  inferIntroducedName,
  isGenericSpeakerName,
  isKnownName,
  pendingApplies,
  type NameInference,
  type PendingIntroduction,
} from "./name-guess";
import { verifyIntroducedName } from "./name-verify";
import { analyzeLine, searchableMetadata } from "./sentiment";
import { generateSessionInsights } from "./speaker-insights";
import { speakerRegistry, type SpeakerMatch } from "./speakers";
import { postAmbientCard } from "../../ui/shell/ambient-cards";
import { formatRelativeTime } from "../../util/date-util";
import { deviceLanguage, identifyLanguage, translateText } from "./translate";

declare const com: any;
declare const java: any;

/**
 * The Microphones session: owns mic capture while the app window is open,
 * computes levels and direction-of-arrival for the Sonic Radar, applies the
 * beam filter, and runs the captions pipeline (utterance segmentation ->
 * speaker voice-print -> language/translation -> sentiment -> storage).
 *
 * Two capture paths, selected by firmware capability and config:
 * - Stock: the glasses stream one mixed mono 16 kHz LC3 channel; the
 *   firmware DSP appends a direction-of-arrival angle and signal-strength
 *   ratio to every 50 ms packet, which drives the radar. The beam filter
 *   gates audio by that angle.
 * - Extended (CFW mic_control, hardware-armed): each temple streams its two
 *   mics as raw PCM 'SM' frames; per-temple delay-and-sum beamforming plus
 *   NLMS noise cancellation run on the phone, and the two temple bearings
 *   are fused for the radar.
 *
 * Neither path can assume an earlier start still holds: the mic enable
 * lives in the glasses session (an arm drop or EvenHub resume clears it),
 * and other mic users preempt the shared tap. A periodic check brings
 * capture up when it isn't and re-acquires it when audio stops arriving.
 */

const SAMPLE_RATE = 16000;
const LEVEL_DECAY = 0.75;
const DOA_SMOOTHING = 0.35;
const CAPTION_LINE_LIMIT = 60;
const RECORDING_AAC_BITRATE = 32_000;
// Encounter popup: a recognized voice not heard for at least this long gets
// the who-is-this card; shorter gaps are the same conversation continuing.
const ENCOUNTER_GAP_MS = 15 * 60 * 1000;
const ENCOUNTER_CARD_TTL_MS = 12_000;
const ENCOUNTER_CARD_MAX_ACTION_ITEMS = 2;
// A temple that has sent no frame (or no bearing) for this long no longer
// counts: its stream stopped, its mics were toggled off, or its arm dropped.
const TEMPLE_STALE_MS = 1000;
// An enabled temple silent this long while forwarding holds gets its config
// re-sent; it is also the time a temple gets to start streaming after each
// CONFIGURE.
const TEMPLE_SILENT_MS = 5000;
// The fused direction of arrival only gates audio while it is this fresh: a
// direction nobody reports any more (Direction detection turned off, the
// temples gone quiet) must not keep muting the captions.
const DOA_STALE_MS = TEMPLE_STALE_MS;
// The caption feed moves to the other temple only once that temple has
// clearly out-heard the current one for a while. Each switch splices in
// audio on another temple's clock, so flapping near the threshold glitches it.
const FEED_SWITCH_RATIO = 1.5;
const FEED_SWITCH_HOLD_MS = 500;
// How often capture is checked: brought up if it isn't, re-acquired if
// audio stopped arriving.
const CAPTURE_CHECK_MS = 3000;
// A caption engine that dies on its own is restarted on the same
// conversation, with growing delays, this many times before captions give up.
const CAPTION_MAX_RESTARTS = 3;
const CAPTION_RESTART_BASE_MS = 2000;
// How long a stopping caption engine gets to deliver its trailing utterance
// before its conversation is closed without it.
const CAPTION_STOP_TIMEOUT_MS = 20_000;
const COMPASS_OWNER = "microphones";
// This app's claim on the shared raw-PCM tap (stock path).
const RAW_CAPTURE_OWNER = "microphones";
const WAITING_TEXT = "Waiting for the glasses microphone...";
const STALLED_TEXT = "No audio from the glasses; reconnecting the mic...";

export type CaptionLine = {
  speakerId: number | null;
  speakerName: string;
  speakerColor: string;
  isWearer: boolean;
  text: string;
  translation: string;
  lang: string;
  emotion: string;
  sentiment: number;
  atMs: number;
};

export type { SpeakerDot } from "./radar-dots";

export type MicSessionState = {
  running: boolean;
  mode: "off" | "stock" | "extended";
  micControlAvailable: boolean;
  statusText: string;
  /** Smoothed levels in [0,1]; stock = [mono], extended = per active mic. */
  levels: number[];
  levelLabels: string[];
  /** Per-meter host-enable flags (a disabled mic still meters, marked off). */
  levelsEnabled: boolean[];
  doaDeviceDeg: number | null;
  doaWorldDeg: number | null;
  ssr: number;
  headingDeg: number | null;
  beamWorldDeg: number;
  beamWidthDeg: number;
  beamFilterOn: boolean;
  beamLocked: boolean;
  ancOn: boolean;
  /** Human-readable description of the active noise-cancellation engine. */
  ancEngine: string;
  captionsActive: boolean;
  /** Why captions aren't running, for the captions view ("" while they are). */
  captionsNote: string;
  captionLines: CaptionLine[];
  speakerDots: SpeakerDot[];
};

type StateListener = (state: MicSessionState) => void;

/** One saved caption conversation: its store row and its running tone average. */
type ConversationRecord = { rowId: number; sentimentSum: number; sentimentCount: number };

/**
 * One caption-engine instance. Its utterance times are on its own sample
 * clock (audio fed to it), converted to wall time by `clock` and to
 * recording time with the recording offset taken at its start; an engine
 * restarted after a failure is a new run on the same conversation.
 */
type CaptionRun = {
  engine: any;
  // The Java listener proxy must stay referenced or it gets GC'd.
  listener: any;
  audioBaseMs: number;
  clock: CaptionClock;
  conversation: ConversationRecord | null;
  /** The app session (start() count) it belongs to. */
  generation: number;
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** Runs once the stopped engine has delivered its trailing utterance. */
  afterStop: (() => void) | null;
};

// Boot-time recovery runs once per process.
let recoveryDone = false;

class MicSession {
  private readonly stateListeners = new Set<StateListener>();
  private running = false;
  private mode: "off" | "stock" | "extended" = "off";
  private statusText = "Idle";
  // Whether the current mode's capture path is up; until it is, the capture
  // check keeps retrying.
  private captureUp = false;
  // Capture is up but audio isn't arriving (the check is re-acquiring it).
  private captureStalled = false;
  // Consecutive checks that found the stock raw tap dead and restarted it.
  private stockRestarts = 0;

  // Radar state.
  private levels: number[] = [];
  private levelLabels: string[] = [];
  private doaDeviceDeg: number | null = null;
  // When doaDeviceDeg was last updated from a reported bearing.
  private doaAtMs = 0;
  private ssr = 0;
  private headingDeg: number | null = null;
  private beamWorldDeg = 0;
  private beamWidthDeg = 60;
  private beamLocked = false;
  private speakerDots: SpeakerDot[] = [];

  // Captions state.
  private captionLines: CaptionLine[] = [];
  // Captions are on for this app session: an engine is running, or being
  // restarted after a failure.
  private captionsActive = false;
  private captionRun: CaptionRun | null = null;
  // Runs told to stop that haven't reported back; each holds its
  // conversation open until its trailing utterance is in.
  private readonly stoppingRuns = new Set<CaptionRun>();
  private conversation: ConversationRecord | null = null;
  private captionFailures = 0;
  private captionRestartTimer: ReturnType<typeof setTimeout> | null = null;
  // Why captions gave up after repeated engine failures ("" when they haven't).
  private captionsFailure = "";
  // Bumped per start(), so a stopping run's late line isn't shown in a later session.
  private sessionGeneration = 0;
  private conversationLang = "und";

  // Recording state.
  private recorder: any = null;
  private recordingPath = "";

  // Stock path subscriptions.
  private offRawPcm: (() => void) | null = null;
  private offFrameMeta: (() => void) | null = null;
  private offCompass: (() => void) | null = null;

  // Extended path.
  private forwardingProxy: any = null;
  private temples = new Map<MicSide, TempleAudioPipeline>();
  private templeAngles: { left: number | null; right: number | null } = { left: null, right: null };
  private templeSsr: { left: number; right: number } = { left: 0, right: 0 };
  private templeAngleAtMs: Record<MicSide, number> = { left: 0, right: 0 };
  private templeFrameAtMs: Record<MicSide, number> = { left: 0, right: 0 };
  // When each temple was last sent CONFIGURE, for its start-up grace period.
  private templeArmedAtMs: Record<MicSide, number> = { left: 0, right: 0 };
  private captionFeedSide: MicSide = "left";
  // When the other temple first clearly out-heard the caption feed's (0 = it hasn't).
  private feedSwitchSinceMs = 0;
  // Cached at capture start so the ~80 Hz packet path never re-reads settings.
  private activeConfig: MicConfig = loadMicConfig();
  // Hot-path flags mirrored from settings so the packet path avoids a JNI
  // read per frame; refreshed on any settings change.
  private beamFilterOn = false;
  private ancOn = true;
  private offSettings: (() => void) | null = null;
  private offSpeakerChanges: (() => void) | null = null;
  private offVoiceActivity: (() => void) | null = null;

  // Phone-side spectral noise suppressor (FaceclawNoiseSuppressor).
  private suppressor: any = null;
  private suppressorEngine = "";

  // True between the caption engine's speech-start event and the utterance
  // that resolves it; while set, the live DOA is attributed to the nearest
  // speaker dot so people are tracked as they move and talk.
  private speechActive = false;

  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private captureCheckTimer: ReturnType<typeof setInterval> | null = null;

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.getState());
    return () => this.stateListeners.delete(listener);
  }

  getState(): MicSessionState {
    return {
      running: this.running,
      mode: this.mode,
      micControlAvailable: micControlSupported(),
      statusText: this.statusText,
      levels: [...this.levels],
      levelLabels: [...this.levelLabels],
      levelsEnabled:
        this.mode === "extended"
          ? MIC_CHANNEL_KEYS.map((key) => this.activeConfig.hostMics[key])
          : this.levelLabels.map(() => true),
      doaDeviceDeg: this.doaDeviceDeg,
      doaWorldDeg: this.doaDeviceDeg === null ? null : this.toWorldDeg(this.doaDeviceDeg),
      ssr: this.ssr,
      headingDeg: this.headingDeg,
      beamWorldDeg: this.beamWorldDeg,
      beamWidthDeg: this.beamWidthDeg,
      beamFilterOn: beamFilterSetting.get(),
      beamLocked: this.beamLocked,
      ancOn: ancEnabledSetting.get(),
      ancEngine: this.describeAncEngine(),
      captionsActive: this.captionsActive,
      captionsNote: this.captionsNote(),
      captionLines: [...this.captionLines],
      speakerDots: [...(this.speakerDots = pruneDots(this.speakerDots, Date.now()))],
    };
  }

  private describeAncEngine(): string {
    if (!this.suppressorEngine) return "";
    return this.mode === "extended"
      ? `${this.suppressorEngine} + inter-mic NLMS`
      : this.suppressorEngine;
  }

  private captionsNote(): string {
    if (this.captionsActive) return "";
    if (this.captionsFailure) {
      return `Captions stopped: ${this.captionsFailure}. Turn Captions back on in the menu to retry.`;
    }
    // Wanted, but waiting for the microphone to come up.
    if (this.running && captionsEnabledSetting.get()) return this.statusText;
    return "Captions are off (enable in the Microphones menu).";
  }

  private notify(): void {
    const state = this.getState();
    this.stateListeners.forEach((listener) => listener(state));
  }

  // ---- lifecycle ----

  start(): void {
    if (this.running || !global.isAndroid) return;
    this.running = true;
    this.sessionGeneration += 1;
    this.captionLines = [];
    this.speakerDots = [];
    this.captionsFailure = "";
    this.conversationLang = "und";

    this.activeConfig = loadMicConfig();
    this.refreshCachedFlags();
    this.mode = this.desiredMode();
    this.offSettings = onSettingsStoreChanged(() => this.handleSettingsChanged());
    this.offSpeakerChanges = speakerRegistry.onChanged(() => this.refreshSpeakerIdentities());
    this.offVoiceActivity = voiceActivity.subscribe((active) => this.handleVoiceActivity(active));
    this.startSuppressor();
    this.startCompass();
    // Captions start once capture is up (bringUpCapture), so a session
    // waiting on the glasses doesn't open an empty conversation.
    this.bringUpCapture();
    // Levels/DOA update at packet rate; coalesce UI renders to 5 Hz.
    this.renderTimer = setInterval(() => this.notify(), 200);
    this.captureCheckTimer = setInterval(() => this.checkCapture(), CAPTURE_CHECK_MS);
    this.notify();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
    if (this.captureCheckTimer) {
      clearInterval(this.captureCheckTimer);
      this.captureCheckTimer = null;
    }
    this.stopCapture();
    this.offSettings?.();
    this.offSettings = null;
    this.offSpeakerChanges?.();
    this.offSpeakerChanges = null;
    this.offVoiceActivity?.();
    this.offVoiceActivity = null;
    // Closes the recording now; the conversation closes once the engine's
    // trailing utterance is in.
    this.stopCaptions();
    this.stopCompass();
    this.suppressor = null;
    this.speechActive = false;
    this.mode = "off";
    this.statusText = "Idle";
    this.captureStalled = false;
    this.levels = [];
    this.clearDirection();
    this.notify();
    void this.applyRetentionSweep();
  }

  private listeningText(): string {
    return this.mode === "extended" ? "Listening (4-mic array)" : "Listening";
  }

  private desiredMode(): "stock" | "extended" {
    return micControlSupported() && this.activeConfig.armHardware ? "extended" : "stock";
  }

  /**
   * Start the current mode's capture path. Until it is up the session stays
   * running and the capture check retries; captions begin once it is.
   */
  private bringUpCapture(): boolean {
    // The voice dialog or Transcribe owns the mic; take it back when it ends.
    if (voiceActivity.isActive() || !this.startCapture()) {
      this.captureUp = false;
      this.statusText = WAITING_TEXT;
      return false;
    }
    this.captureUp = true;
    this.captureStalled = false;
    this.statusText = this.listeningText();
    if (captionsEnabledSetting.get() && !this.captionsActive && !this.captionsFailure) {
      this.startCaptions();
    }
    return true;
  }

  /** Start the current mode's capture path, undoing any partial start on failure. */
  private startCapture(): boolean {
    try {
      if (this.mode === "extended" ? this.startExtended() : this.startStock()) return true;
    } catch (error) {
      console.warn(`mic capture start failed: ${error}`);
    }
    this.stopCapture();
    return false;
  }

  private stopCapture(): void {
    this.captureUp = false;
    if (this.mode === "extended") {
      this.stopExtended();
    } else {
      this.stopStock();
    }
  }

  /**
   * Persist a Microphone setup change. While running it takes effect live:
   * toggling 4-mic capture swaps the capture path, and any other change is
   * re-sent to the streaming temples.
   */
  updateConfig(mutate: (config: MicConfig) => MicConfig): void {
    const config = mutate(loadMicConfig());
    const directionChanged = config.beamform !== this.activeConfig.beamform;
    const modeBefore = this.mode;
    // Before saving: the save's settings event re-checks the capture mode.
    this.activeConfig = config;
    saveMicConfig(config);
    if (this.running) {
      if (directionChanged) this.clearDirection();
      this.syncCaptureMode();
      if (
        this.mode === modeBefore &&
        this.mode === "extended" &&
        this.captureUp &&
        !voiceActivity.isActive()
      ) {
        this.armExtended();
      }
    }
    this.notify();
  }

  private handleSettingsChanged(): void {
    this.refreshCachedFlags();
    // The developer gate on mic control can change under a running session.
    this.syncCaptureMode();
  }

  /** Swap capture paths when 4-mic capture (or its developer gate) changed. */
  private syncCaptureMode(): void {
    if (!this.running) return;
    const mode = this.desiredMode();
    if (mode === this.mode) return;
    this.stopCapture();
    this.mode = mode;
    this.clearDirection();
    this.bringUpCapture();
  }

  private refreshCachedFlags(): void {
    this.beamFilterOn = beamFilterSetting.get();
    const wasOn = this.ancOn;
    this.ancOn = ancEnabledSetting.get();
    if (this.ancOn && !wasOn) {
      // The noise floor learned before the toggle-off is stale.
      try {
        this.suppressor?.reset();
      } catch {
        // Suppressor gone; startSuppressor will rebuild on next session.
      }
    }
  }

  /**
   * The Microphones config as capture-processing options for mic use
   * elsewhere in the app (assistant push-to-talk, hands-free, Transcribe):
   * noise suppression and the Sonic Radar beam, resolved to the device frame
   * with the current compass heading. Valid whether or not this session is
   * running — the beam aim and settings persist.
   */
  captureProcessingOptions(): {
    noiseSuppression: boolean;
    beamFilter: { centerDeg: number; halfWidthDeg: number } | null;
  } {
    return {
      noiseSuppression: ancEnabledSetting.get(),
      beamFilter: beamFilterSetting.get()
        ? { centerDeg: this.beamDeviceDeg(), halfWidthDeg: this.beamWidthDeg / 2 }
        : null,
    };
  }

  /**
   * Speech capture (the assistant modal, a dictation draft, Transcribe) owns
   * the single G2 mic while active. Pause our capture for its duration and
   * re-acquire when it ends — the stock raw tap is preempted by the bridge
   * and must be re-requested; the extended SM stream must stop so the
   * stock-format capture can run at all.
   */
  private handleVoiceActivity(active: boolean): void {
    if (!this.running) return;
    if (active) {
      if (this.mode === "extended" && this.captureUp) {
        micArrayController.stopStreaming();
        try {
          this.nativeCommunicator()?.stopG2AudioForwarding();
        } catch {
          // Disconnected; nothing to stop.
        }
      }
      return;
    }
    // Take the mic back now rather than at the next check.
    this.checkCapture();
  }

  /**
   * Bring capture up if it isn't, and re-acquire it if audio stopped
   * arriving. Runs every CAPTURE_CHECK_MS and when speech capture ends.
   */
  private checkCapture(): void {
    if (!this.running || voiceActivity.isActive()) return;
    try {
      if (!this.captureUp) {
        // Retrying while disconnected would only log skipped sends.
        if (this.nativeCommunicator()?.isSessionReady()) this.bringUpCapture();
        return;
      }
      const healthy = this.mode === "extended" ? this.checkExtendedCapture() : this.checkStockCapture();
      this.setCaptureStalled(!healthy);
    } catch (error) {
      console.warn(`mic capture check failed: ${error}`);
    }
  }

  private setCaptureStalled(stalled: boolean): void {
    if (stalled === this.captureStalled) return;
    this.captureStalled = stalled;
    this.statusText = stalled ? STALLED_TEXT : this.listeningText();
  }

  /**
   * The stock raw tap dies with the glasses session, and an STT capture
   * preempts it. Restart it whenever it isn't live. Returns false (stalled)
   * while disconnected or once restarts keep failing.
   */
  private checkStockCapture(): boolean {
    if (voiceControlBridge.isRawCaptureLive()) {
      this.stockRestarts = 0;
      return true;
    }
    const communicator = this.nativeCommunicator();
    if (!communicator?.isSessionReady()) return false;
    voiceControlBridge.startRawCapture({ communicator, owner: RAW_CAPTURE_OWNER });
    // One restart is routine (after the voice dialog, or a reconnect); only
    // report a stall once restarts keep failing.
    this.stockRestarts += 1;
    return this.stockRestarts < 2;
  }

  /**
   * The extended stream's forwarding lives in the glasses session: an arm
   * drop or EvenHub resume clears it, so re-establish it and re-send the
   * config. With forwarding in place, each enabled temple must actually be
   * streaming: a lost CONFIGURE or a temple that restarted on its own looks
   * like silence, so a temple quiet past its grace period is reconfigured.
   * Returns whether audio is arriving from every enabled temple.
   */
  private checkExtendedCapture(): boolean {
    const communicator = this.nativeCommunicator();
    if (!communicator?.isSessionReady()) return false;
    if (!communicator.isAudioCaptureActive()) {
      if (!this.forwardingProxy || !communicator.startG2AudioForwarding(this.forwardingProxy)) return false;
      // Routine after the voice dialog or a reconnect; the frame check below
      // reports a stall if the temples don't start streaming.
      return this.armExtended() && !this.captureStalled;
    }
    const now = Date.now();
    const wire = wireConfig(this.activeConfig);
    let healthy = true;
    for (const side of ["left", "right"] as const) {
      if (!templeActive(this.activeConfig, side)) continue;
      if (now - this.templeFrameAtMs[side] < TEMPLE_SILENT_MS) continue;
      if (now - this.templeArmedAtMs[side] < TEMPLE_SILENT_MS) {
        // Just (re)configured: give it time to start streaming, without
        // calling it healthy if it was already stalled.
        if (this.captureStalled) healthy = false;
        continue;
      }
      healthy = false;
      this.templeArmedAtMs[side] = now;
      micArrayController.reconfigureTemple(wire, side);
    }
    return healthy;
  }

  private startSuppressor(): void {
    try {
      this.suppressor = new com.faceclaw.app.FaceclawNoiseSuppressor(SAMPLE_RATE);
      this.suppressorEngine = String(com.faceclaw.app.FaceclawNoiseSuppressor.engineDescription());
    } catch (error) {
      console.warn(`noise suppressor unavailable: ${error}`);
      this.suppressor = null;
      this.suppressorEngine = "";
    }
  }

  // ---- radar controls ----

  setBeamWorldDeg(deg: number): void {
    this.beamWorldDeg = normalizeDeg(deg);
    this.beamLocked = false;
    this.notify();
  }

  adjustBeamWidth(deltaDeg: number): void {
    this.beamWidthDeg = Math.max(20, Math.min(180, this.beamWidthDeg + deltaDeg));
    this.notify();
  }

  toggleBeamLock(): void {
    this.beamLocked = !this.beamLocked;
    this.notify();
  }

  private toWorldDeg(deviceDeg: number): number {
    const heading = this.headingDeg;
    if (heading === null) return normalizeDeg(deviceDeg);
    const world = deviceToWorld((deviceDeg * Math.PI) / 180, this.headOrientation());
    return normalizeDeg((world * 180) / Math.PI);
  }

  private headOrientation(): HeadOrientation {
    return { compassHeading: ((this.headingDeg ?? 0) * Math.PI) / 180, imuYaw: 0 };
  }

  /** Device-frame beam center, for steering and gating. */
  private beamDeviceDeg(): number {
    if (this.headingDeg === null) return this.beamWorldDeg;
    const device = steerWorldToDevice((this.beamWorldDeg * Math.PI) / 180, this.headOrientation());
    return normalizeDeg((device.azimuth * 180) / Math.PI);
  }

  /**
   * While speech is being heard, glide the nearest speaker dot along with the
   * live DOA (in the compass-anchored world frame) and mark it as actively
   * speaking; between utterances everyone shows as silent.
   */
  private trackLiveSpeaker(): void {
    if (!this.speechActive || this.ssr <= 0 || this.doaDeviceDeg === null) {
      clearSpeaking(this.speakerDots);
      return;
    }
    trackSpeakingDot(this.speakerDots, this.toWorldDeg(this.doaDeviceDeg), Date.now());
  }

  private inBeam(deviceAngleDeg: number): boolean {
    return angleInArc(
      (deviceAngleDeg * Math.PI) / 180,
      (this.beamDeviceDeg() * Math.PI) / 180,
      ((this.beamWidthDeg / 2) * Math.PI) / 180,
    );
  }

  /** Record a newly reported direction of arrival (device frame). */
  private updateDirection(deviceDeg: number, nowMs: number): void {
    this.doaDeviceDeg = smoothAngleDeg(this.doaDeviceDeg, deviceDeg, DOA_SMOOTHING);
    this.doaAtMs = nowMs;
    if (this.beamLocked && this.doaDeviceDeg !== null) {
      this.beamWorldDeg = this.toWorldDeg(this.doaDeviceDeg);
    }
  }

  private clearDirection(): void {
    this.doaDeviceDeg = null;
    this.doaAtMs = 0;
    this.ssr = 0;
    this.templeAngles = { left: null, right: null };
    this.templeSsr = { left: 0, right: 0 };
    this.templeAngleAtMs = { left: 0, right: 0 };
  }

  /**
   * Beam filter: whether to drop audio because it arrives from outside the
   * beam. Only a current direction can gate; with none, audio passes.
   */
  private outsideBeam(): boolean {
    if (!this.beamFilterOn || this.ssr <= 0 || this.doaDeviceDeg === null) return false;
    if (Date.now() - this.doaAtMs >= DOA_STALE_MS) return false;
    return !this.inBeam(this.doaDeviceDeg);
  }

  // ---- compass (world-frame radar + beam-follow while head turns) ----

  private startCompass(): void {
    try {
      setCompassEnabled(true, COMPASS_OWNER);
      this.offCompass = addCompassListener((event) => {
        if (event.headingDegrees >= 0) {
          this.headingDeg = event.headingDegrees;
        }
      });
    } catch (error) {
      console.warn(`compass unavailable: ${error}`);
    }
  }

  private stopCompass(): void {
    this.offCompass?.();
    this.offCompass = null;
    try {
      setCompassEnabled(false, COMPASS_OWNER);
    } catch {
      // Disconnected; the stream is already gone.
    }
  }

  // ---- stock path ----

  private startStock(): boolean {
    const communicator = this.nativeCommunicator();
    // The tap only records intent without a session; wait for one instead.
    if (!communicator?.isSessionReady()) return false;
    this.levels = [0];
    this.levelLabels = ["Glasses mic"];
    this.stockRestarts = 0;
    const started = voiceControlBridge.startRawCapture({ communicator, owner: RAW_CAPTURE_OWNER });
    if (!started) return false;
    this.offRawPcm = voiceControlBridge.onRawPcm((pcm) => this.handleStockPcm(pcm));
    this.offFrameMeta = voiceControlBridge.onFrameMeta((meta) => {
      this.ssr = meta.ssr;
      if (meta.angleDegrees !== 0 || meta.ssr !== 0) {
        this.updateDirection(meta.angleDegrees, Date.now());
      }
      this.trackLiveSpeaker();
    });
    return true;
  }

  private stopStock(): void {
    this.offRawPcm?.();
    this.offRawPcm = null;
    this.offFrameMeta?.();
    this.offFrameMeta = null;
    voiceControlBridge.stopRawCapture(RAW_CAPTURE_OWNER);
  }

  private handleStockPcm(pcm: Uint8Array): void {
    const level = pcmLevel(pcm);
    this.levels[0] = Math.max(level, (this.levels[0] ?? 0) * LEVEL_DECAY);
    if (this.outsideBeam()) return;
    this.feedPcm(pcm);
  }

  // ---- extended path (CFW mic_control 'SM' frames) ----

  private startExtended(): boolean {
    const communicator = this.nativeCommunicator();
    if (!communicator?.isSessionReady()) return false;
    // Each active temple streams its full front+rear stereo pair; the four
    // mics are split, metered, and selected here on the host.
    this.levelLabels = MIC_CHANNEL_KEYS.map(micChannelLabel);
    this.levels = MIC_CHANNEL_KEYS.map(() => 0);
    this.temples = new Map<MicSide, TempleAudioPipeline>([
      ["left", new TempleAudioPipeline("left", SAMPLE_RATE)],
      ["right", new TempleAudioPipeline("right", SAMPLE_RATE)],
    ]);
    this.forwardingProxy = new com.faceclaw.app.FaceclawAudioPacketListener({
      onAudioPacket: (data: any, arm: string, _arrivalMs: number) => {
        this.handleExtendedPacket(toUint8Array(data), String(arm));
      },
    });
    if (!communicator.startG2AudioForwarding(this.forwardingProxy)) return false;
    return this.armExtended();
  }

  /** Send the config to the temples, starting each one's grace period to begin streaming. */
  private armExtended(): boolean {
    const now = Date.now();
    this.templeArmedAtMs = { left: now, right: now };
    return micArrayController.apply(wireConfig(this.activeConfig));
  }

  /**
   * Toggle one of the four microphones (host-side selection). Takes effect
   * immediately: the channel stops feeding levels-for-use, beamforming, and
   * captions; a temple with both mics off has its stream stopped entirely.
   */
  setMicChannelEnabled(key: MicChannelKey, enabled: boolean): void {
    this.updateConfig((config) => ({ ...config, hostMics: { ...config.hostMics, [key]: enabled } }));
  }

  private stopExtended(): void {
    micArrayController.stopStreaming();
    const communicator = this.nativeCommunicator();
    try {
      communicator?.stopG2AudioForwarding();
    } catch {
      // Already disconnected.
    }
    this.forwardingProxy = null;
    this.temples.clear();
    this.templeAngles = { left: null, right: null };
    this.templeSsr = { left: 0, right: 0 };
    this.templeAngleAtMs = { left: 0, right: 0 };
    this.templeFrameAtMs = { left: 0, right: 0 };
    this.templeArmedAtMs = { left: 0, right: 0 };
    this.feedSwitchSinceMs = 0;
  }

  /** A temple's last bearing, or null once it has gone quiet. */
  private freshTempleAngle(side: MicSide, nowMs: number): number | null {
    return nowMs - this.templeAngleAtMs[side] < TEMPLE_STALE_MS ? this.templeAngles[side] : null;
  }

  private handleExtendedPacket(data: Uint8Array, arm: string): void {
    const frame = decodeMicStreamFrame(data);
    if (!frame) {
      // Stock-format packets can still arrive before arming completes.
      if (isStockAudioPacket(data)) return;
      return;
    }
    const side: MicSide = arm === "L" ? "left" : "right";
    const channels = splitInterleavedPcm16(frame);
    if (!channels || channels.length === 0) return;
    const now = Date.now();
    this.templeFrameAtMs[side] = now;

    // Meter every arriving channel — a host-disabled mic still shows its
    // live level (marked off in the UI), it just doesn't feed anything.
    // Channel order within a temple's frame is [front, rear]; level slots
    // follow MIC_CHANNEL_KEYS: [L front, L rear, R front, R rear].
    const slotBase = side === "left" ? 0 : 2;
    channels.forEach((channel, index) => {
      const slot = slotBase + Math.min(index, 1);
      if (slot < this.levels.length) {
        const level = floatLevel(channel);
        this.levels[slot] = Math.max(level, (this.levels[slot] ?? 0) * LEVEL_DECAY);
      }
    });

    // Per-temple bearing from the on-device TDOA angle.
    if (frame.angleDegrees !== 0 || frame.ssr !== 0) {
      this.templeAngles[side] = frame.angleDegrees;
      this.templeSsr[side] = frame.ssr;
      this.templeAngleAtMs[side] = now;
      // A temple that stopped reporting must not keep steering the fusion.
      const left = this.freshTempleAngle("left", now);
      const right = this.freshTempleAngle("right", now);
      let fusedDeg: number;
      if (left !== null && right !== null) {
        const fused = fuseBearings(
          (left * Math.PI) / 180,
          Math.max(1, this.templeSsr.left),
          (right * Math.PI) / 180,
          Math.max(1, this.templeSsr.right),
        );
        fusedDeg = (fused * 180) / Math.PI;
      } else {
        fusedDeg = (left ?? right)!;
      }
      this.ssr = Math.max(left === null ? 0 : this.templeSsr.left, right === null ? 0 : this.templeSsr.right);
      this.updateDirection(fusedDeg, now);
      this.trackLiveSpeaker();
    }

    // Host-side mic selection, then beamform + ANC within the temple, then
    // feed the stronger temple's enhanced mono to captions/recording.
    // Cross-temple sample mixing is deliberately avoided: the temples run
    // on independent clocks.
    const hostMics = this.activeConfig.hostMics;
    const frontEnabled = hostMics[micChannelKey(side, "front")];
    const rearEnabled = channels.length >= 2 && hostMics[micChannelKey(side, "rear")];
    if (!frontEnabled && !rearEnabled) return;
    if (frontEnabled && rearEnabled) {
      const pipeline = this.temples.get(side);
      if (!pipeline) return;
      pipeline.enableANC = this.ancOn;
      const target = { azimuth: (this.beamDeviceDeg() * Math.PI) / 180 };
      const enhanced = pipeline.process(channels[0]!, channels[1]!, target);
      this.deliverExtendedAudio(side, enhanced);
    } else {
      // Single-mic temple: no pair to steer, pass the enabled channel through.
      this.deliverExtendedAudio(side, frontEnabled ? channels[0]! : channels[1]!);
    }
  }

  private deliverExtendedAudio(side: MicSide, samples: Float32Array): void {
    // Feed captions from one temple only.
    this.updateCaptionFeedSide(Date.now());
    if (side !== this.captionFeedSide) return;
    if (this.outsideBeam()) return;
    this.feedPcm(floatToPcm16(samples));
  }

  /**
   * Pick the temple that feeds captions: the one hearing more signal, among
   * the temples with an enabled microphone that are still streaming. A
   * switch needs the other temple ahead by FEED_SWITCH_RATIO for
   * FEED_SWITCH_HOLD_MS; losing the current temple switches at once.
   */
  private updateCaptionFeedSide(nowMs: number): void {
    const usable = (side: MicSide) =>
      templeActive(this.activeConfig, side) && nowMs - this.templeFrameAtMs[side] < TEMPLE_STALE_MS;
    const heard = (side: MicSide) => (this.freshTempleAngle(side, nowMs) === null ? 0 : this.templeSsr[side]);
    const current = this.captionFeedSide;
    const other: MicSide = current === "left" ? "right" : "left";
    if (!usable(other)) {
      this.feedSwitchSinceMs = 0;
      return;
    }
    if (!usable(current)) {
      this.captionFeedSide = other;
      this.feedSwitchSinceMs = 0;
      return;
    }
    if (heard(other) <= heard(current) * FEED_SWITCH_RATIO) {
      this.feedSwitchSinceMs = 0;
      return;
    }
    if (this.feedSwitchSinceMs === 0) {
      this.feedSwitchSinceMs = nowMs;
    } else if (nowMs - this.feedSwitchSinceMs >= FEED_SWITCH_HOLD_MS) {
      this.captionFeedSide = other;
      this.feedSwitchSinceMs = 0;
    }
  }

  // ---- shared audio consumers ----

  private feedPcm(pcm: Uint8Array): void {
    const run = this.captionRun;
    const engine = run?.engine;
    if (!engine && !this.recorder) return;
    let javaBytes = toJavaBytes(pcm);
    if (this.ancOn && this.suppressor) {
      try {
        javaBytes = this.suppressor.process(javaBytes);
      } catch (error) {
        console.warn(`noise suppression failed: ${error}`);
      }
    }
    if (run) {
      try {
        run.engine.acceptPcm(javaBytes);
        run.clock.noteFed(Number(javaBytes.length), Date.now());
      } catch (error) {
        console.warn(`caption feed failed: ${error}`);
      }
    }
    if (this.recorder) {
      try {
        this.recorder.append(javaBytes);
      } catch (error) {
        console.warn(`recording append failed: ${error}`);
      }
    }
  }

  // ---- captions ----

  /** Whether captions are on, as the menu toggle shows it (off after they gave up). */
  captionsEnabled(): boolean {
    return captionsEnabledSetting.get() && !this.captionsFailure;
  }

  setCaptionsEnabled(enabled: boolean): void {
    captionsEnabledSetting.set(enabled);
    this.captionsFailure = "";
    if (this.running) {
      if (enabled && !this.captionsActive) {
        // While capture is still coming up, bringUpCapture starts them.
        if (this.captureUp) this.startCaptions();
      } else if (!enabled && this.captionsActive) {
        this.stopCaptions();
      }
    }
    this.notify();
  }

  /** Begin a captioned conversation: the engine, then its store row and recording. */
  private startCaptions(): void {
    if (this.captionsActive) return;
    const run = this.createCaptionRun();
    if (!run) {
      this.captionsFailure = "the caption engine could not start";
      return;
    }
    this.captionsActive = true;
    this.captionsFailure = "";
    this.captionFailures = 0;
    this.encounterShown.clear();
    this.conversation = this.openConversation();
    run.conversation = this.conversation;
    this.captionRun = run;
    if (this.conversation && this.shouldRecord()) this.startRecording(this.conversation);
  }

  /** Start a caption engine on the current conversation, or null if it can't start. */
  private createCaptionRun(): CaptionRun | null {
    let engine: any = null;
    try {
      engine = new com.faceclaw.app.FaceclawCaptionEngine();
      const run: CaptionRun = {
        engine,
        listener: null,
        // A restarted engine's clock starts at zero partway into the recording.
        audioBaseMs: this.recorder ? Number(this.recorder.getDurationMs()) : 0,
        clock: new CaptionClock(SAMPLE_RATE, Date.now()),
        conversation: this.conversation,
        generation: this.sessionGeneration,
        stopTimer: null,
        afterStop: null,
      };
      run.listener = new com.faceclaw.app.FaceclawCaptionEngineListener({
        onUtterance: (text: string, embedding: any, startMs: number, endMs: number, _peakRms: number) => {
          // Never let an exception escape into the engine's Java callback.
          try {
            this.handleUtterance(run, String(text), embedding, Number(startMs), Number(endMs));
          } catch (error) {
            console.warn(`caption utterance failed: ${error}`);
          }
        },
        onSpeechStart: (_startMs: number) => {
          if (run === this.captionRun) this.speechActive = true;
        },
        onStatus: (status: string) => {
          // Capture problems outrank the engine's own progress messages.
          if (run === this.captionRun && this.captureUp && !this.captureStalled) {
            this.statusText = String(status);
          }
        },
        onStopped: (error: string | null) => {
          try {
            this.handleRunStopped(run, error === null || error === undefined ? null : String(error));
          } catch (stopError) {
            console.warn(`caption engine stop handling failed: ${stopError}`);
          }
        },
      });
      engine.setListener(run.listener);
      // Live captions are a separate sherpa-onnx pipeline (FaceclawCaptionEngine)
      // that only ever uses Moonshine; unaffected by the two-model on-device
      // Whisper addition in native/voice-control.ts's push-to-talk path.
      engine.setAsrModelDir(isAsrModelReady("moonshine") ? moonshineModelDir() : null);
      engine.setSpeakerModelPath(micModelPath("speaker-embedding"));
      engine.start();
      return run;
    } catch (error) {
      console.warn(`caption engine start failed: ${error}`);
      try {
        engine?.stop();
      } catch {
        // It never started.
      }
      return null;
    }
  }

  private handleRunStopped(run: CaptionRun, error: string | null): void {
    if (run === this.captionRun) {
      // The live engine ended on its own (its models failed to load, or the
      // worker died): restart it on the same conversation.
      this.captionRun = null;
      this.speechActive = false;
      this.scheduleCaptionRestart(error ?? "the caption engine stopped");
      return;
    }
    this.settleRun(run);
  }

  private scheduleCaptionRestart(reason: string): void {
    this.captionFailures += 1;
    if (this.captionFailures > CAPTION_MAX_RESTARTS) {
      console.warn(`captions giving up after ${this.captionFailures} failures: ${reason}`);
      this.stopCaptions();
      this.captionsFailure = reason;
      this.notify();
      return;
    }
    this.statusText = `Captions failed (${reason}); restarting...`;
    this.captionRestartTimer = setTimeout(() => {
      this.captionRestartTimer = null;
      if (!this.running || !this.captionsActive || this.captionRun) return;
      const run = this.createCaptionRun();
      if (run) {
        this.captionRun = run;
      } else {
        this.scheduleCaptionRestart("the caption engine could not restart");
      }
    }, CAPTION_RESTART_BASE_MS * this.captionFailures);
    this.notify();
  }

  private clearCaptionRestart(): void {
    if (this.captionRestartTimer) {
      clearTimeout(this.captionRestartTimer);
      this.captionRestartTimer = null;
    }
  }

  /**
   * End the captioned conversation. The recording holds every byte the
   * engine was fed, so it closes now; the store row stays open until the
   * engine has delivered its trailing utterance (or a timeout passes).
   */
  private stopCaptions(): void {
    if (!this.captionsActive) return;
    this.captionsActive = false;
    this.speechActive = false;
    this.clearCaptionRestart();
    const endedAtMs = Date.now();
    const run = this.captionRun;
    this.captionRun = null;
    const conversation = this.conversation;
    this.conversation = null;
    this.stopRecording(true, conversation);
    if (run) {
      this.stopRun(run, () => this.finishConversation(conversation, endedAtMs));
    } else {
      this.finishConversation(conversation, endedAtMs);
    }
  }

  private stopRun(run: CaptionRun, afterStop: () => void): void {
    run.afterStop = afterStop;
    this.stoppingRuns.add(run);
    run.stopTimer = setTimeout(() => {
      console.warn("caption engine did not report stopping; closing its conversation anyway");
      this.settleRun(run);
    }, CAPTION_STOP_TIMEOUT_MS);
    try {
      run.engine.requestStop();
    } catch (error) {
      console.warn(`caption engine stop failed: ${error}`);
      this.settleRun(run);
    }
  }

  /** A stopping run is done (reported back, or timed out): close what it held open. */
  private settleRun(run: CaptionRun): void {
    if (!this.stoppingRuns.delete(run)) return;
    if (run.stopTimer) clearTimeout(run.stopTimer);
    run.stopTimer = null;
    const afterStop = run.afterStop;
    run.afterStop = null;
    afterStop?.();
  }

  /** The store row for a new conversation, when captions are being saved. */
  private openConversation(): ConversationRecord | null {
    if (!saveCaptionsSetting.get() || captionsRetentionSetting.get() === "none") return null;
    try {
      const rowId = Number(
        this.store().startSession(Date.now(), `Conversation ${new Date().toLocaleString()}`),
      );
      return rowId >= 0 ? { rowId, sentimentSum: 0, sentimentCount: 0 } : null;
    } catch (error) {
      console.warn(`caption session start failed: ${error}`);
      return null;
    }
  }

  private finishConversation(conversation: ConversationRecord | null, endedAtMs: number): void {
    if (!conversation) return;
    const avg = conversation.sentimentCount > 0 ? conversation.sentimentSum / conversation.sentimentCount : 0;
    try {
      this.store().endSession(conversation.rowId, endedAtMs, "", "", avg);
    } catch (error) {
      console.warn(`session finish failed: ${error}`);
    }
    // Recap/action-items/facts per speaker, generated in the background with
    // the on-phone model (no-op when it isn't downloaded).
    generateSessionInsights(conversation.rowId);
  }

  /** The next captioned utterance enrolls (or refreshes) the wearer's voice. */
  armWearerEnrollment(): void {
    this.wearerEnrollmentArmed = true;
    this.statusText = "Speak now to enroll your voice...";
    this.notify();
  }

  private wearerEnrollmentArmed = false;
  // A heard third-party introduction waiting for its subject to speak.
  private pendingIntroduction: PendingIntroduction | null = null;
  // Speakers already greeted with an encounter card in this caption run.
  private encounterShown = new Set<number>();

  /**
   * When a familiar voice is recognized after an absence, post a small
   * ambient card at the bottom of the glasses screen: who this is, when you
   * last spoke, a remembered fact, and open action items from that
   * conversation. Once per speaker per caption run; named contacts only —
   * a "Speaker 3" card would tell the wearer nothing.
   */
  private maybeShowEncounterCard(match: SpeakerMatch): void {
    const profile = match.profile;
    if (
      match.classification !== "known" ||
      profile.isWearer ||
      isGenericSpeakerName(profile.name) ||
      this.encounterShown.has(profile.id)
    ) {
      return;
    }
    if (
      match.previousLastHeardAt <= 0 ||
      Date.now() - match.previousLastHeardAt < ENCOUNTER_GAP_MS
    ) {
      // Still mark it shown: the gap only shrinks as the conversation goes on.
      this.encounterShown.add(profile.id);
      return;
    }
    this.encounterShown.add(profile.id);
    const lines: string[] = [];
    if (profile.facts.length) lines.push(profile.facts[0]!);
    for (const item of profile.actionItems.slice(0, ENCOUNTER_CARD_MAX_ACTION_ITEMS)) {
      lines.push(`To do: ${item}`);
    }
    postAmbientCard({
      id: `encounter-${profile.id}`,
      title: `${profile.name} · last spoke ${formatRelativeTime(match.previousLastHeardAt)} ago`,
      lines,
      expiresAtMs: Date.now() + ENCOUNTER_CARD_TTL_MS,
    });
  }

  /**
   * Apply a heard introduction, gated in tiers: a candidate whose given name
   * is in the known-names dataset (the SSA-derived list) is trusted
   * outright — the dataset is a positive-only signal, and skipping the LLM
   * here also protects real common names from an LLM misfire. An unknown
   * candidate — which is where introduction-shaped phraseology produces
   * false positives — gets the on-phone LLM check when the model is
   * available. A null verdict (model absent, busy, or timed out) trusts the
   * heuristic — renames are retroactively correctable, so a missing model
   * must not disable naming, and an unknown name must not be rejected just
   * for being absent from the dataset.
   */
  private async applyIntroduction(
    inference: NameInference,
    speakerId: number,
    sentence: string,
  ): Promise<void> {
    try {
      const verdict = isKnownName(inference.name)
        ? true
        : await verifyIntroducedName(inference, sentence);
      if (verdict === false) return;
      if (inference.kind === "self") {
        const profile = speakerRegistry.byId(speakerId);
        if (!profile || profile.isWearer || !isGenericSpeakerName(profile.name)) return;
        speakerRegistry.rename(speakerId, inference.name);
      } else {
        this.pendingIntroduction = { name: inference.name, bySpeakerId: speakerId, atMs: Date.now() };
      }
    } catch (error) {
      console.warn(`introduction apply failed: ${error}`);
    }
  }

  /**
   * A speaker profile changed (spoken introduction landed, or the user
   * corrected a name/color in the phone UI): retro-update every caption
   * line and radar dot already attributed to that voice-print, so past
   * entries show the corrected identity too. Stored transcript segments
   * reference the speaker id, so the database view corrects itself.
   */
  private refreshSpeakerIdentities(): void {
    let changed = false;
    for (const line of this.captionLines) {
      if (line.speakerId === null) continue;
      const profile = speakerRegistry.byId(line.speakerId);
      if (!profile) continue;
      if (
        line.speakerName !== profile.name ||
        line.speakerColor !== profile.color ||
        line.isWearer !== profile.isWearer
      ) {
        line.speakerName = profile.name;
        line.speakerColor = profile.color;
        line.isWearer = profile.isWearer;
        changed = true;
      }
    }
    for (const dot of this.speakerDots) {
      const profile = speakerRegistry.byId(dot.speakerId);
      if (!profile) continue;
      if (dot.name !== profile.name || dot.color !== profile.color) {
        dot.name = profile.name;
        dot.color = profile.color;
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  private handleUtterance(
    run: CaptionRun,
    text: string,
    embedding: any,
    startMs: number,
    endMs: number,
  ): void {
    if (!text.trim() && !embedding) return;
    const live = run === this.captionRun;
    // A stopping run's trailing line still shows if it belongs to this app
    // session; it is saved to its own conversation either way.
    const shown = this.running && run.generation === this.sessionGeneration;
    if (live) this.captionFailures = 0;
    const embeddingFloats = embedding ? floatArrayToFloat32(embedding) : null;
    if (live && this.wearerEnrollmentArmed && embeddingFloats) {
      this.wearerEnrollmentArmed = false;
      try {
        const wearer = speakerRegistry.enrollWearer(embeddingFloats);
        this.statusText = `Enrolled your voice as "${wearer.name}"`;
      } catch (error) {
        console.warn(`wearer enrollment failed: ${error}`);
        this.statusText = "Voice enrollment failed";
      }
    }
    let match: SpeakerMatch | null = null;
    if (embeddingFloats) {
      try {
        match = speakerRegistry.assign(embeddingFloats);
      } catch (error) {
        // Still caption the line, just unattributed.
        console.warn(`speaker assignment failed: ${error}`);
      }
    }
    if (match && shown) this.maybeShowEncounterCard(match);
    // Spoken introductions name the auto-numbered speakers: "I'm Alice"
    // renames the speaker of the line; "this is Bob" pends the name for the
    // next different still-generic voice. User-set names are never touched.
    if (match && shown && text.trim()) {
      const now = Date.now();
      const pending = this.pendingIntroduction;
      if (pending && pendingApplies(pending, match.profile.id, match.profile.name, now)) {
        // Verified when it was pended; apply directly.
        speakerRegistry.rename(match.profile.id, pending.name);
        this.pendingIntroduction = null;
      }
      const inference = inferIntroducedName(text);
      if (inference && !(inference.kind === "self" && match.profile.isWearer)) {
        // The rename lands asynchronously (after optional LLM verification);
        // speaker-change propagation retro-fixes the lines already shown.
        void this.applyIntroduction(inference, match.profile.id, text);
      }
      const refreshed = speakerRegistry.byId(match.profile.id);
      if (refreshed) match = { ...match, profile: refreshed };
    }
    const isWearer = match?.profile.isWearer ?? false;
    const doaAtUtterance = shown ? this.doaDeviceDeg : null;
    const analyzed = text.trim() ? analyzeLine(text) : null;
    const conversation = run.conversation;
    if (analyzed && conversation) {
      conversation.sentimentSum += analyzed.score;
      conversation.sentimentCount += 1;
    }

    const line: CaptionLine = {
      speakerId: match?.profile.id ?? null,
      speakerName: match?.profile.name ?? "Speaker",
      speakerColor: match?.profile.color ?? "#90A4AE",
      isWearer,
      text: text.trim(),
      translation: "",
      lang: "",
      emotion: analyzed?.emotion ?? "",
      sentiment: analyzed?.score ?? 0,
      atMs: run.clock.wallMs(startMs),
    };
    if (shown) {
      this.captionLines.push(line);
      if (this.captionLines.length > CAPTION_LINE_LIMIT) {
        this.captionLines.splice(0, this.captionLines.length - CAPTION_LINE_LIMIT);
      }

      // Radar dot at the utterance's direction (world frame, so it stays put
      // as the head turns and follows the person when they move).
      this.speechActive = false;
      clearSpeaking(this.speakerDots);
      if (match && doaAtUtterance !== null) {
        this.speakerDots = placeDotForUtterance(
          this.speakerDots,
          { speakerId: match.profile.id, name: match.profile.name, color: match.profile.color },
          this.toWorldDeg(doaAtUtterance),
          Date.now(),
        );
      }
    }

    let segmentId = -1;
    if (conversation && line.text) {
      try {
        segmentId = Number(
          this.store().insertSegment(
            JSON.stringify({
              sessionId: conversation.rowId,
              speakerId: match?.profile.id,
              startedAt: run.clock.wallMs(startMs),
              endedAt: run.clock.wallMs(endMs),
              audioOffsetMs: run.audioBaseMs + startMs,
              text: line.text,
              sentiment: line.sentiment,
              emotion: line.emotion,
              searchMeta: analyzed ? searchableMetadata(analyzed.emotion, analyzed.score) : "",
              angle: doaAtUtterance === null ? undefined : Math.round(doaAtUtterance),
              embeddingBase64: embeddingFloats ? encodeEmbeddingBase64(embeddingFloats) : undefined,
            }),
          ),
        );
      } catch (error) {
        console.warn(`caption segment save failed: ${error}`);
      }
    }
    if (shown) this.notify();

    // Language identification + translation are async; the UI line and the
    // stored segment update when they resolve.
    if (line.text) {
      void this.identifyAndTranslate(line, segmentId);
    }
  }

  private async identifyAndTranslate(line: CaptionLine, segmentId: number): Promise<void> {
    try {
      const lang = await identifyLanguage(line.text);
      // Hysteresis: a single short line rarely proves a language switch, but
      // repeated confident detections move the conversation language.
      if (lang !== "und") {
        this.conversationLang = lang;
        line.lang = lang;
      }
      const target = deviceLanguage();
      let translation = "";
      if (translateEnabledSetting.get() && lang !== "und" && lang !== target) {
        translation = await translateText(line.text, lang, target);
        line.translation = translation;
      }
      if (segmentId >= 0 && (line.lang || translation)) {
        this.store().updateSegment(
          segmentId,
          JSON.stringify({
            lang: line.lang,
            translation,
            translationLang: translation ? target : undefined,
          }),
        );
      }
      this.notify();
    } catch (error) {
      console.warn(`caption translate failed: ${error}`);
    }
  }

  /** Whether an utterance from this voice may trigger voice commands. */
  commandsAllowedFor(embedding: Float32Array | null): boolean {
    if (!wearerCommandsOnlySetting.get()) return true;
    if (!embedding) return false;
    return speakerRegistry.isWearerVoice(embedding);
  }

  // ---- recording ----

  /**
   * Recordings belong to a saved caption conversation: retention and the
   * phone UI find audio only through its session row, so a file recorded
   * without one would never be shown or expired.
   */
  private shouldRecord(): boolean {
    return saveRecordingsSetting.get() && recordingsRetentionSetting.get() !== "none";
  }

  private startRecording(conversation: ConversationRecord): void {
    try {
      const dir = recordingsDir();
      if (!dir) throw new Error("external storage unavailable");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.recordingPath = `${dir}/conversation-${stamp}.wav`;
      this.recorder = new com.faceclaw.app.FaceclawWavRecorder(this.recordingPath, SAMPLE_RATE, 1);
    } catch (error) {
      console.warn(`recording start failed: ${error}`);
      this.recorder = null;
      this.recordingPath = "";
      return;
    }
    // Link the file at once: if the process dies mid-recording, the row
    // still names it, and boot recovery repairs and keeps it.
    try {
      this.store().setSessionAudio(conversation.rowId, this.recordingPath, "wav");
    } catch (error) {
      console.warn(`recording link failed: ${error}`);
    }
  }

  private stopRecording(keep: boolean, conversation: ConversationRecord | null): void {
    const recorder = this.recorder;
    this.recorder = null;
    if (!recorder) return;
    const wavPath = this.recordingPath;
    try {
      const bytes = Number(recorder.finish());
      if (!keep || bytes < SAMPLE_RATE || !conversation) {
        // Under half a second of audio isn't worth keeping, and audio with no
        // session row to own it would be unreachable and never expire.
        recorder.discard();
        if (conversation) this.store().setSessionAudio(conversation.rowId, null, null);
        return;
      }
      const store = this.store();
      store.setSessionAudio(conversation.rowId, wavPath, "wav");
      transcodeRecording(store, conversation.rowId, wavPath);
    } catch (error) {
      console.warn(`recording stop failed: ${error}`);
    }
  }

  // ---- persistence plumbing ----

  private store(): any {
    const context = Utils.android.getApplicationContext();
    return com.faceclaw.app.FaceclawConversationStore.getInstance(context);
  }

  async applyRetentionSweep(): Promise<void> {
    if (!global.isAndroid || this.running) return;
    try {
      const now = Date.now();
      const captionCutoff = retentionCutoffMs(captionsRetentionSetting.get(), now);
      const recordingCutoff = retentionCutoffMs(recordingsRetentionSetting.get(), now);
      const summary = String(this.store().applyRetention(captionCutoff, recordingCutoff));
      const parsed = JSON.parse(summary) as { sessionsDeleted?: number; recordingsDeleted?: number };
      if ((parsed.sessionsDeleted ?? 0) > 0 || (parsed.recordingsDeleted ?? 0) > 0) {
        console.log(`mic retention sweep: ${summary}`);
      }
    } catch (error) {
      console.warn(`retention sweep failed: ${error}`);
    }
  }

  /**
   * Repair what a dead process left behind, once per process at boot:
   * conversations it never closed, recording files no session row knows
   * about, and recordings never transcoded (header patched to the audio on
   * disk, then transcoded). The steps fail independently, and the last one
   * works from what the store still holds as WAV rather than from what this
   * boot closed, so whatever a failure leaves is picked up by a later boot.
   */
  recoverInterruptedConversations(): void {
    if (!global.isAndroid || recoveryDone || this.running) return;
    recoveryDone = true;
    let store: any;
    try {
      store = this.store();
    } catch (error) {
      console.warn(`mic recovery failed: ${error}`);
      return;
    }
    let closed: number[] = [];
    try {
      const rows = JSON.parse(
        String(store.closeInterruptedSessions(JSON.stringify(this.openConversationRows()))),
      ) as Array<{ id: number }>;
      closed = rows.map((row) => Number(row.id));
    } catch (error) {
      console.warn(`mic recovery: closing conversations failed: ${error}`);
    }
    for (const rowId of closed) generateSessionInsights(rowId);
    // Before any transcode below starts writing, so its output isn't swept.
    let removed = 0;
    try {
      const dir = recordingsDir();
      if (dir) removed = Number(store.deleteUnreferencedRecordings(dir));
    } catch (error) {
      console.warn(`mic recovery: orphan sweep failed: ${error}`);
    }
    // The ones just closed, plus any whose transcode died with an earlier
    // process; patching an already-finished header changes nothing.
    let untranscoded: Array<{ id: number; audioPath: string }> = [];
    try {
      untranscoded = JSON.parse(String(store.listUntranscodedSessions())) as typeof untranscoded;
    } catch (error) {
      console.warn(`mic recovery: listing recordings failed: ${error}`);
    }
    for (const session of untranscoded) {
      recoverRecording(store, Number(session.id), String(session.audioPath));
    }
    if (closed.length > 0 || removed > 0 || untranscoded.length > 0) {
      console.log(
        `mic recovery: closed ${closed.length} conversation(s), removed ${removed} orphaned recording(s), ` +
          `finishing ${untranscoded.length} recording(s)`,
      );
    }
  }

  /** Session rows legitimately still open: the live conversation and ones awaiting a trailing line. */
  private openConversationRows(): number[] {
    const rows = new Set<number>();
    if (this.conversation) rows.add(this.conversation.rowId);
    for (const run of this.stoppingRuns) {
      if (run.conversation) rows.add(run.conversation.rowId);
    }
    return Array.from(rows);
  }

  private nativeCommunicator(): any {
    try {
      return com.faceclaw.app.FaceclawBleCommunicator.getActive();
    } catch {
      return null;
    }
  }
}

// ---- helpers ----

/**
 * The config as sent to the temples: each active temple always streams its
 * full front+rear pair, and per-mic selection happens host-side.
 */
function wireConfig(config: MicConfig): MicConfig {
  return { ...config, channelMask: 0b11 };
}

function pcmLevel(pcm: Uint8Array): number {
  let sumSquares = 0;
  const count = pcm.length / 2;
  if (count === 0) return 0;
  for (let i = 0; i < count; i++) {
    let value = pcm[i * 2]! | (pcm[i * 2 + 1]! << 8);
    if (value >= 0x8000) value -= 0x10000;
    sumSquares += value * value;
  }
  return rmsToLevel(Math.sqrt(sumSquares / count) / 32768);
}

function floatLevel(samples: Float32Array): number {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i]! * samples[i]!;
  return rmsToLevel(Math.sqrt(sumSquares / Math.max(1, samples.length)));
}

/** Map RMS in [0,1] to a meter position with a log-ish curve (mic peaks ~0.1 FS). */
function rmsToLevel(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    let value = Math.round(samples[i]! * 32767);
    if (value > 32767) value = 32767;
    if (value < -32768) value = -32768;
    if (value < 0) value += 0x10000;
    out[i * 2] = value & 0xff;
    out[i * 2 + 1] = (value >> 8) & 0xff;
  }
  return out;
}

function floatArrayToFloat32(javaFloats: any): Float32Array {
  const length = javaFloats.length;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Number(javaFloats[i]);
  return out;
}

function encodeEmbeddingBase64(embedding: Float32Array): string {
  return encodeBase64(new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength));
}

function moonshineModelDir(): string {
  const context = Utils.android.getApplicationContext();
  return `${context.getFilesDir().getAbsolutePath()}/faceclaw-voice-asr/sherpa-onnx-moonshine-base-en-quantized-2026-02-27`;
}

/** Where recordings live, or null while external storage is unavailable. */
function recordingsDir(): string | null {
  const context = Utils.android.getApplicationContext();
  const base = context.getExternalFilesDir(null);
  return base ? `${base.getAbsolutePath()}/mic-recordings` : null;
}

function deleteFile(path: string): void {
  try {
    new java.io.File(path).delete();
  } catch (error) {
    console.warn(`could not delete ${path}: ${error}`);
  }
}

// Transcoder listeners are referenced only from Java while a transcode runs;
// hold them here so they aren't GC'd before their callback.
const pendingTranscodes = new Set<any>();

/**
 * Transcode a finished WAV recording to M4A in the background and move its
 * session onto it. The WAV is deleted only once the row names the M4A, so a
 * failure at any step leaves the session pointing at a file that exists.
 */
function transcodeRecording(store: any, rowId: number, wavPath: string): void {
  const m4aPath = wavPath.replace(/\.wav$/, ".m4a");
  const listener = new com.faceclaw.app.FaceclawAudioTranscoder.Listener({
    onDone: (outputPath: string, _outputBytes: number) => {
      pendingTranscodes.delete(listener);
      try {
        store.setSessionAudio(rowId, String(outputPath), "aac");
      } catch (error) {
        console.warn(`recording audio update failed: ${error}`);
        deleteFile(String(outputPath));
        return;
      }
      deleteFile(wavPath);
    },
    onError: (message: string) => {
      pendingTranscodes.delete(listener);
      console.warn(`recording transcode failed: ${message}`);
    },
  });
  pendingTranscodes.add(listener);
  try {
    // deleteSourceOnSuccess false: the WAV goes only after the row update above.
    new com.faceclaw.app.FaceclawAudioTranscoder(wavPath, m4aPath, RECORDING_AAC_BITRATE, false, listener).start();
  } catch (error) {
    pendingTranscodes.delete(listener);
    console.warn(`recording transcode start failed: ${error}`);
  }
}

/**
 * Finish a recording left as WAV (its process died writing or transcoding
 * it): patch the header to the audio on disk, then transcode it as a normal
 * stop would. Too short (or gone) and it is dropped from the session instead.
 */
function recoverRecording(store: any, rowId: number, wavPath: string): void {
  try {
    const bytes = Number(com.faceclaw.app.FaceclawWavRecorder.repairHeader(wavPath, SAMPLE_RATE, 1));
    if (bytes < SAMPLE_RATE) {
      deleteFile(wavPath);
      store.setSessionAudio(rowId, null, null);
      return;
    }
    transcodeRecording(store, rowId, wavPath);
  } catch (error) {
    console.warn(`recording recovery failed (${wavPath}): ${error}`);
  }
}

export const micSession = new MicSession();
