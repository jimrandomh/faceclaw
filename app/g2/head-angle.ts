import { addImuListener, imuPitchDegrees, setImuReportEnabled, type ImuReading } from "../native/imu";
import { getHeadUpStatus, setHeadUpTrigger, type HeadUpStatus } from "../native/glasses-controls";
import { getStringSetting, setStringSetting } from "../native/settings-store";
import { glanceAngleTriggerDegrees } from "../apps/glanceboard/glanceboard-settings";

// Same ImuReportPace code the accelerometer demo uses (not literal Hz).
const IMU_REPORT_PACE = 200;
/** How often the live reading checks visibility and repaints a changed value. */
const LIVE_TICK_MS = 250;
/** Weight of each new sample in the smoothed pitch. */
const LIVE_SMOOTHING = 0.3;
/** A reading older than this (or none this long after the stream started) is shown as missing. */
const LIVE_STALE_MS = 3_000;

/**
 * The head's pitch, live, for the Head tilt angle picker. The IMU report
 * stream runs while `visible()` holds (checked every tick, so it stops while
 * the screen is off or the window is in the background) and until stop().
 * text() is the footer line; a changed value repaints at most once a tick.
 */
class LiveHeadPitch {
  private pitch: number | null = null;
  private lastSampleAt = 0;
  private streaming = false;
  private streamingSince = 0;
  private shown = "";
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly visible: () => boolean,
    private readonly repaint: () => void,
  ) {
    this.unsubscribe = addImuListener((reading) => this.onReading(reading));
    this.timer = setInterval(() => this.tick(), LIVE_TICK_MS);
    this.tick();
  }

  text(): string {
    return this.shown;
  }

  stop(): void {
    clearInterval(this.timer);
    this.unsubscribe();
    if (this.streaming) setImuReportEnabled(false, IMU_REPORT_PACE);
    this.streaming = false;
  }

  private onReading(reading: ImuReading): void {
    // Glasses temples only (1 right, 3 left, 0 unspecified); the ring is 2.
    if (!this.streaming || reading.source === 2) return;
    if (!(Math.hypot(reading.x, reading.y, reading.z) > 1e-6)) return;
    const pitch = imuPitchDegrees(reading);
    this.pitch = this.pitch === null ? pitch : this.pitch + LIVE_SMOOTHING * (pitch - this.pitch);
    this.lastSampleAt = Date.now();
  }

  private tick(): void {
    const now = Date.now();
    const visible = this.visible();
    if (visible !== this.streaming) {
      setImuReportEnabled(visible, IMU_REPORT_PACE);
      this.streaming = visible;
      this.streamingSince = now;
      this.pitch = null;
    }
    const text = this.format(now);
    if (text !== this.shown) {
      this.shown = text;
      this.repaint();
    }
  }

  private format(now: number): string {
    if (this.pitch !== null && now - this.lastSampleAt < LIVE_STALE_MS) return `Head now: ${Math.round(this.pitch)}°`;
    return now - Math.max(this.streamingSince, this.lastSampleAt) < LIVE_STALE_MS ? "Head now: …" : "Head now: no data";
  }
}

/**
 * The Head tilt angle picker's footer: the head's current pitch, read while
 * the picker is open and `visible()` holds (enumSettingMenuItem pickerFooter).
 */
export function liveHeadPitchFooter(visible: () => boolean): { text: () => string; open: (repaint: () => void) => () => void } {
  let reader: LiveHeadPitch | null = null;
  return {
    text: () => reader?.text() ?? "",
    open: (repaint) => {
      const opened = new LiveHeadPitch(visible, repaint);
      reader = opened;
      return () => {
        opened.stop();
        if (reader === opened) reader = null;
      };
    },
  };
}

// The glasses' own head-up switch and angle from before Faceclaw first changed
// them, as "switch,angle", or "" when none is held. Kept here (not only in the
// session) so "Glasses default" can still restore them after an app restart.
const ORIGINAL_KEY = "glanceboard.headTiltOriginal";

function savedOriginal(): { switch: number; angle: number } | null {
  const [sw, angle] = getStringSetting(ORIGINAL_KEY, "").split(",").map(Number);
  return (sw === 0 || sw === 1) && Number.isInteger(angle) ? { switch: sw, angle } : null;
}

/**
 * Push the wanted trigger to the session (on change and on each connect):
 * the Head tilt angle while the Glanceboard is enabled, else none, which
 * writes back the glasses' own values if Faceclaw changed them.
 */
export function applyGlanceAngle(): boolean {
  const sent = setHeadUpTrigger(glanceAngleTriggerDegrees(), savedOriginal());
  syncGlanceAngleOriginal();
  return sent;
}

/**
 * Keep the persisted original in step with the session: save the values the
 * session captured before its first write, and drop them once a read shows
 * them restored. Called on apply, from the controller's periodic refresh, and
 * when the settings row draws.
 */
export function syncGlanceAngleOriginal(status: HeadUpStatus | null = getHeadUpStatus()): void {
  if (!status) return;
  const saved = savedOriginal();
  if (!saved) {
    if (status.originalSwitch === 0 || status.originalSwitch === 1) {
      setStringSetting(ORIGINAL_KEY, `${status.originalSwitch},${status.originalAngle}`);
    }
    return;
  }
  if (
    glanceAngleTriggerDegrees() === 0 &&
    status.desired < 0 &&
    !status.restorePending &&
    status.switch === saved.switch &&
    status.angle === saved.angle
  ) {
    setStringSetting(ORIGINAL_KEY, "");
  }
}

/** The glasses' current head-up trigger (angle + calibration), 0 when off, or null when not read yet. */
export function glassesHeadUpTrigger(status: HeadUpStatus | null = getHeadUpStatus()): number | null {
  if (!status || status.switch < 0) return null;
  return status.switch === 1 ? status.angle + status.calibration : 0;
}
