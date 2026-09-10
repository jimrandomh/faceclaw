/**
 * Arbitrates the glasses' magnetometer compass (CFW mode-10 stream) among
 * running EvenHub apps, mirroring the IMU router. Only the foreground app
 * receives headings, so a backgrounded app can't keep the sensor running.
 *
 * The raw reading is NOT pre-calibrated — the magnetometer is in the right
 * arm, which rests on the head with a wearer-dependent curl (see compass-app
 * memory). Each delivery also carries the Compass app's wearer-calibrated
 * magnetic heading and, when the phone has a location, declination and the
 * true heading, so apps needn't redo that work.
 */
import { addCompassListener, setCompassEnabled, COMPASS_CHANGED, type CompassEvent } from "../../native/compass";
import { isCompassCalibrated } from "../compass/calibration";
import { refreshDeclination } from "../compass/declination";
import { resolveHeading } from "../compass/heading";

/** Wire shape of the `compass` extension event (faceclaw-extensions `CompassReading`). */
export type EvenHubCompassReading = {
  headingDegrees: number;
  magneticHeadingDegrees: number;
  wearerCalibrated: boolean;
  declinationDegrees?: number;
  trueHeadingDegrees?: number;
};

export type EvenHubCompassClient = {
  readonly windowId: string;
  isForeground(): boolean;
  deliverCompass(reading: EvenHubCompassReading): void;
};

export function buildCompassReading(rawDegrees: number): EvenHubCompassReading {
  const resolved = resolveHeading(rawDegrees);
  const reading: EvenHubCompassReading = {
    headingDegrees: rawDegrees,
    magneticHeadingDegrees: resolved.magneticDegrees,
    wearerCalibrated: isCompassCalibrated(),
  };
  if (resolved.declinationDegrees !== null && resolved.trueDegrees !== null) {
    reading.declinationDegrees = resolved.declinationDegrees;
    reading.trueHeadingDegrees = resolved.trueDegrees;
  }
  return reading;
}

class EvenHubCompassRouter {
  private readonly requesting = new Set<EvenHubCompassClient>();
  private active: EvenHubCompassClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private enabled = false;

  requestCompass(client: EvenHubCompassClient): void {
    this.requesting.add(client);
    this.evaluate();
  }

  releaseCompass(client: EvenHubCompassClient): void {
    if (!this.requesting.delete(client)) return;
    this.evaluate();
  }

  notifyEligibilityChanged(): void {
    this.evaluate();
  }

  private eligible(): EvenHubCompassClient | null {
    return Array.from(this.requesting).find((client) => client.isForeground()) ?? null;
  }

  private evaluate(): void {
    const next = this.eligible();
    this.active = next;
    if (next) {
      if (!this.unsubscribe) {
        this.unsubscribe = addCompassListener((event: CompassEvent) => {
          // Only heading updates carry a real heading; calibration events use -1.
          if (event.command === COMPASS_CHANGED && event.headingDegrees >= 0) {
            this.active?.deliverCompass(buildCompassReading(event.headingDegrees));
          }
        });
      }
      if (!this.enabled) {
        setCompassEnabled(true);
        this.enabled = true;
        // Uses location only if the wearer already granted it; an app turning
        // on the compass is not a reason to raise a system permission prompt.
        refreshDeclination();
      }
    } else {
      if (this.enabled) {
        setCompassEnabled(false);
        this.enabled = false;
      }
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
  }
}

export const evenHubCompassRouter = new EvenHubCompassRouter();
