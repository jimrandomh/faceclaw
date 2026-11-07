/**
 * The browser demo has no microphone path. The shell hides voice entry points
 * (voiceInputEnabled: false) and apps that need speech say so, so this only has
 * to keep their subscriptions harmless.
 */
import type { CloudSttTranscriptEvent } from "./cloud-stt";

export type VoiceControlState = { status: string; listening: boolean; detail: string };
export type VoiceProviderKind = "onboard" | "onboard-whisper" | "elevenlabs" | "whisper" | "soniox" | "whisper-server";
export type VoiceTranscriptEvent = CloudSttTranscriptEvent & { text: string; isFinal: boolean };
export type PushToTalkOptions = { communicator: unknown; provider: VoiceProviderKind } & Record<string, unknown>;
export type RawPcmListener = (pcm: Uint8Array) => void;
export type MicFrameMeta = { angleDegrees: number; ssr: number };
export type FrameMetaListener = (meta: MicFrameMeta) => void;

const noSubscription = (): (() => void) => () => {};

class WebVoiceControlBridge {
  /** Said once, for the one thing still listening (Teleprompter, which then just scrolls). */
  onStatus(listener: (state: VoiceControlState) => void): () => void {
    setTimeout(() => listener({ status: "Scroll to read", listening: false, detail: "" }), 0);
    return () => {};
  }
  onTranscript = noSubscription as (listener: (event: VoiceTranscriptEvent) => void) => () => void;
  onSpeechEnd = noSubscription as (listener: () => void) => () => void;
  onSpeechPause = noSubscription as (listener: () => void) => () => void;
  onRawPcm = noSubscription as (listener: RawPcmListener) => () => void;
  onMicLevel = noSubscription as (listener: (level: number) => void) => () => void;
  onFrameMeta = noSubscription as (listener: FrameMetaListener) => () => void;
  reportPermissionPrompt(): void {}
  reportPermissionDenied(): void {}
  reportStartFailed(_reason: string): void {}
  startPushToTalk(_options: unknown): void {}
  stopPushToTalk(): void {}
  startContinuousCapture(_options: unknown): void {}
  stopContinuousCapture(): void {}
  retargetContinuousCapture(_options: unknown): void {}
  startRawCapture(_options: unknown): boolean { return false; }
  stopRawCapture(_owner: string): void {}
  isRawCaptureLive(): boolean { return false; }
  stop(): void {}
  handleSessionEnded(): void {}
  hasSuspendedCapture(): boolean { return false; }
  holdsCapture(_holder: unknown): boolean { return false; }
  isCaptureHeld(): boolean { return false; }
  resumeCapture(_options: unknown): void {}
}

export const voiceControlBridge = new WebVoiceControlBridge();
