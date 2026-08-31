import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { useMicControlSetting } from "../../ui/dashboard-settings";
import { toJavaBytes } from "../../native/cloud-stt";
import { toUint8Array } from "../../util/array-util";
import {
  MIC_LEASE_MS,
  decodeMicStatus,
  defaultMicConfig,
  encodeMicControl,
  templeActive,
  type MicConfig,
  type MicOp,
  type MicSide,
  type MicStatus,
} from "./mic-protocol";

declare const com: any;

/**
 * Host-side controller for the CFW mic_control array: sends the same config
 * to both temples (each temple is its own endpoint and its own 2-mic array),
 * tracks per-temple field-104 status, and keeps the 90 s streaming lease
 * renewed while capture is armed. Degrades cleanly on firmware without the
 * feature: micControlSupported() is false and apply() refuses to arm.
 */

const CONFIG_SETTING_KEY = "microphones.array-config";
const LEASE_RENEW_MS = Math.floor(MIC_LEASE_MS / 3);

export type MicArrayStatuses = { left: MicStatus | null; right: MicStatus | null };

function activeCommunicator(): any {
  if (!global.isAndroid) return null;
  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

/** True when the connected glasses advertise the CFW mic_control feature. */
export function micControlAdvertised(): boolean {
  const communicator = activeCommunicator();
  if (!communicator) return false;
  try {
    const caps = String(communicator.getFirmwareCapabilities() ?? "");
    return caps.trim().split(/\s+/).includes("micctl");
  } catch {
    return false;
  }
}

/**
 * True when the connected glasses advertise the CFW mic_control feature AND
 * the "Use microphone control" developer setting is on. With the setting off
 * (the default), Faceclaw behaves exactly as it would on firmware without the
 * micctl caps token.
 */
export function micControlSupported(): boolean {
  return useMicControlSetting.get() && micControlAdvertised();
}

export function loadMicConfig(): MicConfig {
  const raw = getStringSetting(CONFIG_SETTING_KEY, "");
  if (!raw) return defaultMicConfig();
  try {
    const parsed = JSON.parse(raw) as Partial<MicConfig>;
    const defaults = defaultMicConfig();
    return {
      ...defaults,
      ...parsed,
      hostMics: { ...defaults.hostMics, ...(parsed.hostMics ?? {}) },
    };
  } catch {
    return defaultMicConfig();
  }
}

export function saveMicConfig(config: MicConfig): void {
  setStringSetting(CONFIG_SETTING_KEY, JSON.stringify(config));
}

class MicArrayController {
  private readonly statusListeners = new Set<(statuses: MicArrayStatuses) => void>();
  private statuses: MicArrayStatuses = { left: null, right: null };
  // The Java listener proxy must stay referenced or it gets GC'd.
  private statusProxy: any | null = null;
  private proxyCommunicator: any | null = null;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private armed = false;

  getStatuses(): MicArrayStatuses {
    return this.statuses;
  }

  onStatus(listener: (statuses: MicArrayStatuses) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.statuses);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * True when both temples report the same active configuration; only then
   * should cross-temple bearing fusion be trusted.
   */
  arrayConsistent(): boolean {
    const { left, right } = this.statuses;
    if (!left || !right) return false;
    return (
      left.active &&
      right.active &&
      left.effectiveRateHz === right.effectiveRateHz &&
      left.codec === right.codec &&
      left.format === right.format
    );
  }

  /**
   * Push the config to the temples. Each active temple streams its full
   * front+rear pair (per-mic selection happens host-side after the split);
   * a temple whose mics are all toggled off gets STOP instead so its stream
   * doesn't spend BLE bandwidth.
   */
  apply(config: MicConfig): boolean {
    const leftActive = templeActive(config, "left");
    const rightActive = templeActive(config, "right");
    if (leftActive || rightActive) {
      if (!this.send("configure", config, "configure", rightActive, leftActive)) return false;
    }
    if (!leftActive || !rightActive) {
      this.send("stop", undefined, "stop-disabled-temple", !rightActive, !leftActive);
    }
    saveMicConfig(config);
    this.armed = config.armHardware && (leftActive || rightActive);
    this.syncLeaseTimer();
    return true;
  }

  query(): boolean {
    return this.send("query", undefined, "query");
  }

  stopStreaming(): void {
    this.armed = false;
    this.syncLeaseTimer();
    this.send("stop", undefined, "stop");
  }

  private renewLease(): void {
    if (!this.armed) return;
    this.send("renew", undefined, "renew");
  }

  private send(
    op: MicOp,
    config: MicConfig | undefined,
    label: string,
    rightTemple = true,
    leftTemple = true,
  ): boolean {
    const communicator = activeCommunicator();
    if (!communicator) return false;
    this.ensureStatusProxy(communicator);
    try {
      const record = encodeMicControl(op, config);
      communicator.sendFaceclawMicControl(toJavaBytes(record), label, rightTemple, leftTemple);
      return true;
    } catch (error) {
      console.warn(`mic control ${label} failed: ${error}`);
      return false;
    }
  }

  private ensureStatusProxy(communicator: any): void {
    if (this.statusProxy && this.proxyCommunicator === communicator) return;
    if (this.statusProxy && this.proxyCommunicator) {
      try {
        this.proxyCommunicator.removeMicStatusListener(this.statusProxy);
      } catch {
        // The old communicator instance may be gone after a reconnect.
      }
    }
    this.statusProxy = new com.faceclaw.app.FaceclawMicStatusListener({
      onMicStatus: (body: any, arm: string) => {
        const status = decodeMicStatus(toUint8Array(body));
        if (!status) return;
        const side: MicSide = String(arm) === "L" ? "left" : "right";
        this.statuses = { ...this.statuses, [side]: { ...status, side } };
        this.statusListeners.forEach((listener) => listener(this.statuses));
      },
    });
    this.proxyCommunicator = communicator;
    communicator.addMicStatusListener(this.statusProxy);
  }

  private syncLeaseTimer(): void {
    if (this.armed && !this.leaseTimer) {
      this.leaseTimer = setInterval(() => this.renewLease(), LEASE_RENEW_MS);
    } else if (!this.armed && this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
  }
}

export const micArrayController = new MicArrayController();
