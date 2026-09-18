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
import type { MicConfig } from "./mic-protocol";
import { micModelPath } from "./mic-models";
import {
  MIC_CHANNEL_KEYS,
  decodeMicStreamFrame,
  isStockAudioPacket,
  micChannelKey,
  micChannelLabel,
  splitConcatenatedPcm16,
  templeActive,
  type MicChannelKey,
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
  captionLines: CaptionLine[];
  speakerDots: SpeakerDot[];
};

type StateListener = (state: MicSessionState) => void;

class MicSession {
  private readonly stateListeners = new Set<StateListener>();
  private running = false;
  private mode: "off" | "stock" | "extended" = "off";
  private statusText = "Idle";

  // Radar state.
  private levels: number[] = [];
  private levelLabels: string[] = [];
  private doaDeviceDeg: number | null = null;
  private ssr = 0;
  private headingDeg: number | null = null;
  private beamWorldDeg = 0;
  private beamWidthDeg = 60;
  private beamLocked = false;
  private speakerDots: SpeakerDot[] = [];

  // Captions state.
  private captionLines: CaptionLine[] = [];
  private captionEngine: any | null = null;
  private captionListenerProxy: any | null = null;
  private captionsActive = false;
  private engineStartWallMs = 0;
  private sessionRowId = -1;
  private sentimentSum = 0;
  private sentimentCount = 0;
  private conversationLang = "und";

  // Recording state.
  private recorder: any | null = null;
  private recordingPath = "";

  // Stock path subscriptions.
  private offRawPcm: (() => void) | null = null;
  private offFrameMeta: (() => void) | null = null;
  private offCompass: (() => void) | null = null;

  // Extended path.
  private forwardingProxy: any | null = null;
  private temples = new Map<MicSide, TempleAudioPipeline>();
  private templeAngles: { left: number | null; right: number | null } = { left: null, right: null };
  private templeSsr: { left: number; right: number } = { left: 0, right: 0 };
  private captionFeedSide: MicSide = "left";
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
  private suppressor: any | null = null;
  private suppressorEngine = "";

  // True between the caption engine's speech-start event and the utterance
  // that resolves it; while set, the live DOA is attributed to the nearest
  // speaker dot so people are tracked as they move and talk.
  private speechActive = false;

  private renderTimer: ReturnType<typeof setInterval> | null = null;

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

  private notify(): void {
    const state = this.getState();
    this.stateListeners.forEach((listener) => listener(state));
  }

  // ---- lifecycle ----

  start(): void {
    if (this.running || !global.isAndroid) return;
    this.running = true;
    this.captionLines = [];
    this.speakerDots = [];
    this.sentimentSum = 0;
    this.sentimentCount = 0;
    this.conversationLang = "und";

    this.activeConfig = loadMicConfig();
    this.refreshCachedFlags();
    this.offSettings = onSettingsStoreChanged(() => this.refreshCachedFlags());
    this.offSpeakerChanges = speakerRegistry.onChanged(() => this.refreshSpeakerIdentities());
    this.offVoiceActivity = voiceActivity.subscribe((active) => this.handleVoiceActivity(active));
    const extended = micControlSupported() && this.activeConfig.armHardware;
    this.mode = extended ? "extended" : "stock";
    this.startSuppressor();
    this.startCompass();
    if (captionsEnabledSetting.get()) {
      this.startCaptions();
    }
    if (saveRecordingsSetting.get() && recordingsRetentionSetting.get() !== "none") {
      this.startRecording();
    }
    const ok = extended ? this.startExtended() : this.startStock();
    if (!ok) {
      this.statusText = "Microphone unavailable (glasses not connected?)";
      this.running = false;
      this.stopCaptions();
      this.stopRecording(false);
      this.stopCompass();
      this.mode = "off";
      this.notify();
      return;
    }
    this.statusText = extended ? "Listening (4-mic array)" : "Listening";
    // Levels/DOA update at packet rate; coalesce UI renders to 5 Hz.
    this.renderTimer = setInterval(() => this.notify(), 200);
    this.notify();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
    if (this.mode === "extended") {
      this.stopExtended();
    } else {
      this.stopStock();
    }
    this.offSettings?.();
    this.offSettings = null;
    this.offSpeakerChanges?.();
    this.offSpeakerChanges = null;
    this.offVoiceActivity?.();
    this.offVoiceActivity = null;
    this.stopCaptions();
    this.stopRecording(true);
    this.stopCompass();
    this.suppressor = null;
    this.speechActive = false;
    this.finishSessionRow();
    this.mode = "off";
    this.statusText = "Idle";
    this.levels = [];
    this.doaDeviceDeg = null;
    this.notify();
    void this.applyRetentionSweep();
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
   * The assistant modal owns the single G2 mic while open. Pause our capture
   * for its duration and re-acquire when it closes — the stock raw tap is
   * preempted by the bridge and must be re-requested; the extended SM stream
   * must stop so the assistant's stock-format session can run at all.
   */
  private handleVoiceActivity(active: boolean): void {
    if (!this.running) return;
    if (active) {
      if (this.mode === "extended") {
        micArrayController.stopStreaming();
        try {
          this.nativeCommunicator()?.stopG2AudioForwarding();
        } catch {
          // Disconnected; nothing to stop.
        }
      }
      return;
    }
    const communicator = this.nativeCommunicator();
    if (!communicator) return;
    if (this.mode === "extended") {
      if (this.forwardingProxy && communicator.startG2AudioForwarding(this.forwardingProxy)) {
        micArrayController.apply({ ...this.activeConfig, channelMask: 0b11 });
      }
    } else {
      voiceControlBridge.startRawCapture({ communicator });
    }
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

  // ---- compass (world-frame radar + beam-follow while head turns) ----

  private startCompass(): void {
    try {
      setCompassEnabled(true);
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
      setCompassEnabled(false);
    } catch {
      // Disconnected; the stream is already gone.
    }
  }

  // ---- stock path ----

  private startStock(): boolean {
    const communicator = this.nativeCommunicator();
    if (!communicator) return false;
    this.levels = [0];
    this.levelLabels = ["Glasses mic"];
    const started = voiceControlBridge.startRawCapture({ communicator });
    if (!started) return false;
    this.offRawPcm = voiceControlBridge.onRawPcm((pcm) => this.handleStockPcm(pcm));
    this.offFrameMeta = voiceControlBridge.onFrameMeta((meta) => {
      this.ssr = meta.ssr;
      if (meta.angleDegrees !== 0 || meta.ssr !== 0) {
        this.doaDeviceDeg = smoothAngleDeg(this.doaDeviceDeg, meta.angleDegrees, DOA_SMOOTHING);
        if (this.beamLocked && this.doaDeviceDeg !== null) {
          this.beamWorldDeg = this.toWorldDeg(this.doaDeviceDeg);
        }
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
    voiceControlBridge.stopRawCapture();
  }

  private handleStockPcm(pcm: Uint8Array): void {
    const level = pcmLevel(pcm);
    this.levels[0] = Math.max(level, (this.levels[0] ?? 0) * LEVEL_DECAY);
    const gated =
      this.beamFilterOn &&
      this.doaDeviceDeg !== null &&
      this.ssr > 0 &&
      !this.inBeam(this.doaDeviceDeg);
    if (gated) return;
    this.feedPcm(pcm);
  }

  // ---- extended path (CFW mic_control 'SM' frames) ----

  private startExtended(): boolean {
    const communicator = this.nativeCommunicator();
    if (!communicator) return false;
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
    if (!micArrayController.apply({ ...this.activeConfig, channelMask: 0b11 })) {
      communicator.stopG2AudioForwarding();
      return false;
    }
    return true;
  }

  /**
   * Toggle one of the four microphones (host-side selection). Takes effect
   * immediately: the channel stops feeding levels-for-use, beamforming, and
   * captions; a temple with both mics off has its stream stopped entirely.
   */
  setMicChannelEnabled(key: MicChannelKey, enabled: boolean): void {
    const config = loadMicConfig();
    config.hostMics = { ...config.hostMics, [key]: enabled };
    saveMicConfig(config);
    this.activeConfig = config;
    if (this.running && this.mode === "extended") {
      micArrayController.apply({ ...config, channelMask: 0b11 });
    }
    this.notify();
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
  }

  private handleExtendedPacket(data: Uint8Array, arm: string): void {
    const frame = decodeMicStreamFrame(data);
    if (!frame) {
      // Stock-format packets can still arrive before arming completes.
      if (isStockAudioPacket(data)) return;
      return;
    }
    const side: MicSide = arm === "L" ? "left" : "right";
    const channels = splitConcatenatedPcm16(frame);
    if (!channels || channels.length === 0) return;

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
      const left = this.templeAngles.left;
      const right = this.templeAngles.right;
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
      this.doaDeviceDeg = smoothAngleDeg(this.doaDeviceDeg, fusedDeg, DOA_SMOOTHING);
      this.ssr = Math.max(this.templeSsr.left, this.templeSsr.right);
      if (this.beamLocked && this.doaDeviceDeg !== null) {
        this.beamWorldDeg = this.toWorldDeg(this.doaDeviceDeg);
      }
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
    // Feed captions from one temple only; prefer the one hearing more
    // signal, among the temples that still have an enabled microphone.
    const leftUsable = templeActive(this.activeConfig, "left");
    const rightUsable = templeActive(this.activeConfig, "right");
    let stronger: MicSide = this.templeSsr.right > this.templeSsr.left * 1.5 ? "right" : "left";
    if (stronger === "right" && !rightUsable) stronger = "left";
    if (stronger === "left" && !leftUsable) stronger = "right";
    if (strongerChanged(this.captionFeedSide, stronger)) {
      this.captionFeedSide = stronger;
    }
    if (side !== this.captionFeedSide) return;
    if (
      this.beamFilterOn &&
      this.doaDeviceDeg !== null &&
      this.ssr > 0 &&
      !this.inBeam(this.doaDeviceDeg)
    ) {
      return;
    }
    this.feedPcm(floatToPcm16(samples));
  }

  // ---- shared audio consumers ----

  private feedPcm(pcm: Uint8Array): void {
    if (!this.captionEngine && !this.recorder) return;
    let javaBytes = toJavaBytes(pcm);
    if (this.ancOn && this.suppressor) {
      try {
        javaBytes = this.suppressor.process(javaBytes);
      } catch (error) {
        console.warn(`noise suppression failed: ${error}`);
      }
    }
    if (this.captionEngine) {
      try {
        this.captionEngine.acceptPcm(javaBytes);
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

  setCaptionsEnabled(enabled: boolean): void {
    captionsEnabledSetting.set(enabled);
    if (!this.running) return;
    if (enabled && !this.captionsActive) {
      this.startCaptions();
      if (saveRecordingsSetting.get() && !this.recorder) this.startRecording();
    } else if (!enabled && this.captionsActive) {
      this.stopCaptions();
      this.finishSessionRow();
    }
    this.notify();
  }

  private startCaptions(): void {
    if (this.captionsActive) return;
    const engine = new com.faceclaw.app.FaceclawCaptionEngine();
    this.captionListenerProxy = new com.faceclaw.app.FaceclawCaptionEngineListener({
      onUtterance: (text: string, embedding: any, startMs: number, endMs: number, peakRms: number) => {
        this.handleUtterance(String(text), embedding, Number(startMs), Number(endMs), Number(peakRms));
      },
      onSpeechStart: (_startMs: number) => {
        this.speechActive = true;
      },
      onStatus: (status: string) => {
        this.statusText = String(status);
      },
    });
    engine.setListener(this.captionListenerProxy);
    // Live captions are a separate sherpa-onnx pipeline (FaceclawCaptionEngine)
    // that only ever uses Moonshine; unaffected by the two-model on-device
    // Whisper addition in native/voice-control.ts's push-to-talk path.
    engine.setAsrModelDir(isAsrModelReady("moonshine") ? moonshineModelDir() : null);
    engine.setSpeakerModelPath(micModelPath("speaker-embedding"));
    engine.start();
    this.captionEngine = engine;
    this.captionsActive = true;
    this.engineStartWallMs = Date.now();
    this.encounterShown.clear();
    if (saveCaptionsSetting.get() && captionsRetentionSetting.get() !== "none") {
      this.sessionRowId = Number(
        this.store().startSession(Date.now(), `Conversation ${new Date().toLocaleString()}`),
      );
    }
  }

  private stopCaptions(): void {
    if (!this.captionsActive) return;
    try {
      this.captionEngine?.stop();
    } catch (error) {
      console.warn(`caption engine stop failed: ${error}`);
    }
    this.captionEngine = null;
    this.captionListenerProxy = null;
    this.captionsActive = false;
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
    text: string,
    embedding: any,
    startMs: number,
    endMs: number,
    _peakRms: number,
  ): void {
    if (!text.trim() && !embedding) return;
    const embeddingFloats = embedding ? floatArrayToFloat32(embedding) : null;
    if (this.wearerEnrollmentArmed && embeddingFloats) {
      this.wearerEnrollmentArmed = false;
      const wearer = speakerRegistry.enrollWearer(embeddingFloats);
      this.statusText = `Enrolled your voice as "${wearer.name}"`;
    }
    let match = embeddingFloats ? speakerRegistry.assign(embeddingFloats) : null;
    if (match) this.maybeShowEncounterCard(match);
    // Spoken introductions name the auto-numbered speakers: "I'm Alice"
    // renames the speaker of the line; "this is Bob" pends the name for the
    // next different still-generic voice. User-set names are never touched.
    if (match && text.trim()) {
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
    const doaAtUtterance = this.doaDeviceDeg;
    const analyzed = text.trim() ? analyzeLine(text) : null;
    if (analyzed) {
      this.sentimentSum += analyzed.score;
      this.sentimentCount += 1;
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
      atMs: this.engineStartWallMs + startMs,
    };
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

    let segmentId = -1;
    if (this.sessionRowId >= 0 && line.text) {
      segmentId = Number(
        this.store().insertSegment(
          JSON.stringify({
            sessionId: this.sessionRowId,
            speakerId: match?.profile.id,
            startedAt: this.engineStartWallMs + startMs,
            endedAt: this.engineStartWallMs + endMs,
            audioOffsetMs: startMs,
            text: line.text,
            sentiment: line.sentiment,
            emotion: line.emotion,
            searchMeta: analyzed ? searchableMetadata(analyzed.emotion, analyzed.score) : "",
            angle: doaAtUtterance === null ? undefined : Math.round(doaAtUtterance),
            embeddingBase64: embeddingFloats ? encodeEmbeddingBase64(embeddingFloats) : undefined,
          }),
        ),
      );
    }
    this.notify();

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

  private startRecording(): void {
    try {
      const context = Utils.android.getApplicationContext();
      const dir = `${context.getExternalFilesDir(null).getAbsolutePath()}/mic-recordings`;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.recordingPath = `${dir}/conversation-${stamp}.wav`;
      this.recorder = new com.faceclaw.app.FaceclawWavRecorder(this.recordingPath, SAMPLE_RATE, 1);
    } catch (error) {
      console.warn(`recording start failed: ${error}`);
      this.recorder = null;
      this.recordingPath = "";
    }
  }

  private stopRecording(keep: boolean): void {
    const recorder = this.recorder;
    this.recorder = null;
    if (!recorder) return;
    try {
      const bytes = Number(recorder.finish());
      if (!keep || bytes < SAMPLE_RATE) {
        // Under half a second of audio isn't worth keeping.
        recorder.discard();
        return;
      }
      const wavPath = this.recordingPath;
      const m4aPath = wavPath.replace(/\.wav$/, ".m4a");
      const sessionRowId = this.sessionRowId;
      const store = this.store();
      if (sessionRowId >= 0) {
        store.setSessionAudio(sessionRowId, wavPath, "wav");
      }
      // Transcode in the background; swap the session's audio to the M4A on
      // success (the transcoder deletes the WAV).
      const transcoder = new com.faceclaw.app.FaceclawAudioTranscoder(
        wavPath,
        m4aPath,
        RECORDING_AAC_BITRATE,
        true,
        new com.faceclaw.app.FaceclawAudioTranscoder.Listener({
          onDone: (outputPath: string, _outputBytes: number) => {
            if (sessionRowId >= 0) {
              store.setSessionAudio(sessionRowId, String(outputPath), "aac");
            }
          },
          onError: (message: string) => {
            console.warn(`recording transcode failed: ${message}`);
          },
        }),
      );
      transcoder.start();
    } catch (error) {
      console.warn(`recording stop failed: ${error}`);
    }
  }

  // ---- persistence plumbing ----

  private store(): any {
    const context = Utils.android.getApplicationContext();
    return com.faceclaw.app.FaceclawConversationStore.getInstance(context);
  }

  private finishSessionRow(): void {
    if (this.sessionRowId < 0) return;
    const avg = this.sentimentCount > 0 ? this.sentimentSum / this.sentimentCount : 0;
    const finishedSessionId = this.sessionRowId;
    try {
      this.store().endSession(finishedSessionId, Date.now(), "", "", avg);
    } catch (error) {
      console.warn(`session finish failed: ${error}`);
    }
    this.sessionRowId = -1;
    // Recap/action-items/facts per speaker, generated in the background with
    // the on-phone model (no-op when it isn't downloaded).
    generateSessionInsights(finishedSessionId);
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

  private nativeCommunicator(): any {
    try {
      return com.faceclaw.app.FaceclawBleCommunicator.getActive();
    } catch {
      return null;
    }
  }
}

// ---- helpers ----

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

function strongerChanged(current: MicSide, candidate: MicSide): boolean {
  return current !== candidate;
}

function moonshineModelDir(): string {
  const context = Utils.android.getApplicationContext();
  return `${context.getFilesDir().getAbsolutePath()}/faceclaw-voice-asr/sherpa-onnx-moonshine-base-en-quantized-2026-02-27`;
}

export const micSession = new MicSession();
