/**
 * Arbitrates the shared G2 accelerometer (cmd-19 IMU report stream) among
 * running EvenHub apps.
 *
 * imuControl(true) registers an app as wanting IMU; only the foreground
 * (active) window actually receives readings, so a backgrounded app can't keep
 * the flaky, battery-costly BLE stream running. Unlike the mic this is NOT
 * gated on screen state — head-gesture apps legitimately want IMU while the
 * display is blanked. Because only one window is foreground, at most one app is
 * ever the active reader, which also avoids two apps fighting over the single
 * global report rate.
 *
 * The IMU stream is historically unreliable (the firmware may not populate it;
 * see the imu-accelerometer memory) — treat it as best-effort.
 */
import { addImuListener, setImuReportEnabled, type ImuReading } from "../../native/imu";

export type EvenHubImuClient = {
  readonly windowId: string;
  isForeground(): boolean;
  deliverImu(reading: ImuReading): void;
};

class EvenHubImuRouter {
  private readonly requesting = new Map<EvenHubImuClient, number>();
  private active: EvenHubImuClient | null = null;
  private unsubscribe: (() => void) | null = null;
  /** The report rate the stream is currently enabled at; 0 = disabled. */
  private enabledFreq = 0;

  /** An app enabled IMU (imuControl true) at the given report rate. */
  requestImu(client: EvenHubImuClient, freq: number): void {
    this.requesting.set(client, freq);
    this.evaluate();
  }

  /** An app disabled IMU, backgrounded past use, or closed. */
  releaseImu(client: EvenHubImuClient): void {
    if (!this.requesting.delete(client)) return;
    this.evaluate();
  }

  /** A requesting app's foreground state changed. */
  notifyEligibilityChanged(): void {
    this.evaluate();
  }

  private eligible(): EvenHubImuClient | null {
    return Array.from(this.requesting.keys()).find((client) => client.isForeground()) ?? null;
  }

  private evaluate(): void {
    const next = this.eligible();
    this.active = next;
    if (next) {
      if (!this.unsubscribe) {
        this.unsubscribe = addImuListener((reading) => this.active?.deliverImu(reading));
      }
      const freq = this.requesting.get(next) ?? 100;
      if (this.enabledFreq !== freq) {
        setImuReportEnabled(true, freq);
        this.enabledFreq = freq;
      }
    } else {
      if (this.enabledFreq !== 0) {
        setImuReportEnabled(false, 0);
        this.enabledFreq = 0;
      }
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
  }
}

export const evenHubImuRouter = new EvenHubImuRouter();
