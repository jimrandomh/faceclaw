/**
 * Arbitrates the single G2 microphone among running EvenHub apps.
 *
 * An app asks for the mic with audioControl(true); it only actually receives
 * audio while it is the foreground (visible) window, the screen is on, and no
 * voice-input modal (the assistant) is active. When any of those stops holding,
 * the app simply stops receiving frames — it is not told, matching the stock
 * contract where a backgrounded app's mic goes silent.
 *
 * Because only one window is foreground at a time, at most one requesting app
 * is ever eligible. The router runs the shared decode-only raw-PCM tap
 * (voiceControlBridge) while an eligible app exists and routes each decoded
 * frame to it; STT sessions preempt the tap at the bridge level.
 */
import { voiceControlBridge } from "../../native/voice-control";
import { voiceActivity } from "../../ui/shell/voice-activity";

declare const com: any;

export type EvenHubMicClient = {
  readonly windowId: string;
  isForeground(): boolean;
  isScreenOn(): boolean;
  deliverAudioPcm(pcm: Uint8Array): void;
};

function activeCommunicator(): any {
  if (!global.isAndroid) return null;
  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

class EvenHubMicRouter {
  private readonly requesting = new Set<EvenHubMicClient>();
  private active: EvenHubMicClient | null = null;
  private unsubscribeRawPcm: (() => void) | null = null;
  private unsubscribeVoiceActivity: (() => void) | null = null;

  /** An app enabled its microphone (audioControl true). */
  requestMic(client: EvenHubMicClient): void {
    this.requesting.add(client);
    this.ensureSubscriptions();
    this.evaluate();
  }

  /** An app disabled its microphone, backgrounded, or closed. */
  releaseMic(client: EvenHubMicClient): void {
    if (!this.requesting.delete(client)) return;
    this.evaluate();
  }

  /** A requesting app's foreground/screen state changed. */
  notifyEligibilityChanged(): void {
    this.evaluate();
  }

  private ensureSubscriptions(): void {
    if (!this.unsubscribeRawPcm) {
      this.unsubscribeRawPcm = voiceControlBridge.onRawPcm((pcm) => {
        this.active?.deliverAudioPcm(pcm);
      });
    }
    if (!this.unsubscribeVoiceActivity) {
      this.unsubscribeVoiceActivity = voiceActivity.subscribe(() => this.evaluate());
    }
  }

  private eligible(): EvenHubMicClient | null {
    if (voiceActivity.isActive()) return null;
    return Array.from(this.requesting).find(
      (client) => client.isForeground() && client.isScreenOn(),
    ) ?? null;
  }

  private evaluate(): void {
    const next = this.eligible();
    this.active = next;
    if (next) {
      // Idempotent: no-op if already running, and re-asserted on every
      // eligibility change so it self-heals after an STT preemption. Returns
      // false if STT currently owns the mic; a later trigger (assistant modal
      // close, foreground/screen change) re-tries.
      voiceControlBridge.startRawCapture({ communicator: activeCommunicator() });
    } else {
      voiceControlBridge.stopRawCapture();
    }
  }
}

export const evenHubMicRouter = new EvenHubMicRouter();
