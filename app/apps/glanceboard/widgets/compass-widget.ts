import { type GrayImage } from "../../../graphics/image";
import { getDefaultMediumFont, getDefaultSmallFont } from "../../../graphics/ui-fonts";
import { hasLocationPermission } from "../../../g2/android-permissions";
import { addCompassListener, COMPASS_CHANGED, setCompassEnabled } from "../../../native/compass";
import { isCompassCalibrated, normalizeHeading } from "../../compass/calibration";
import { cardinalDirection, createCompassBackground, drawCompassRose, layoutCompassRose, TICK_HEIGHT } from "../../compass/compass-rose";
import { getDeclinationAvailability, onDeclinationChanged, refreshDeclination } from "../../compass/declination";
import { getNorthReference, resolveHeading } from "../../compass/heading";
import { type GlanceWidget } from "../widget";

/** Owner token for the refcounted magnetometer, distinct from the Compass app's. */
const COMPASS_OWNER = "glanceboard";
const TOP_PAD = 4;
const BOTTOM_PAD = 4;
const EDGE_PAD = 8;
const MAX_ROSE_RADIUS = 60;

/**
 * The Compass app's rose at card size: heading readout above, tilted rose
 * below. Turns the magnetometer on for as long as the board shows it (the
 * Compass app keeps its own hold, so the two never switch each other off).
 * Never prompts for location: true north is used when a declination is
 * already known, otherwise the readout says it is magnetic.
 */
export class CompassWidget implements GlanceWidget {
  private rawHeading: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeDeclination: (() => void) | null = null;
  private enabled = false;
  private background: { key: string; image: GrayImage } | null = null;

  start(requestRender: () => void): void {
    this.unsubscribe = addCompassListener((event) => {
      if (event.command === COMPASS_CHANGED && event.headingDegrees >= 0) {
        this.rawHeading = normalizeHeading(event.headingDegrees);
        requestRender();
      }
    });
    this.unsubscribeDeclination = onDeclinationChanged(requestRender);
    if (!this.enabled) {
      this.enabled = true;
      setCompassEnabled(true, COMPASS_OWNER);
    }
    if (getNorthReference() === "true" && hasLocationPermission()) refreshDeclination();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeDeclination?.();
    this.unsubscribeDeclination = null;
    if (this.enabled) {
      this.enabled = false;
      setCompassEnabled(false, COMPASS_OWNER);
    }
  }

  private statusText(): string | null {
    if (this.rawHeading === null) return "Waiting for compass";
    if (!isCompassCalibrated()) return "Uncalibrated";
    if (getNorthReference() === "true" && getDeclinationAvailability() !== "available") return "Magnetic";
    return null;
  }

  paint(image: GrayImage): void {
    const medium = getDefaultMediumFont();
    const small = getDefaultSmallFont();
    const { width, height } = image;
    const heading = this.rawHeading === null ? null : resolveHeading(this.rawHeading).displayDegrees;
    const headingText = heading === null ? "--°" : `${Math.round(heading)}° ${cardinalDirection(heading)}`;
    const status = this.statusText();
    const textHeight = medium.lineHeight + (status ? small.lineHeight + 2 : 0);
    const cx = width / 2;
    const { cy, radius, ringTop } = layoutCompassRose({
      width,
      height,
      cx,
      topClearance: TOP_PAD + textHeight + 4,
      bottomPad: BOTTOM_PAD,
      edgePad: EDGE_PAD,
      maxRadius: MAX_ROSE_RADIUS,
      minRadius: 16,
    });
    const fade = heading === null ? 0.45 : 1;
    const y = Math.max(TOP_PAD, Math.round((ringTop - TICK_HEIGHT - textHeight) / 2));
    const clipY = y + textHeight + 4;
    const key = [width, height, cx, cy, radius, clipY, fade].join(",");
    if (this.background?.key !== key) {
      this.background = { key, image: createCompassBackground(width, height, cx, cy, radius, clipY, fade) };
    }
    // composeInto keeps the background's cached interior texture as a
    // deferred image draw, so the wire planner can restore it from cache.
    this.background.image.composeInto(image, 0, 0);
    drawCompassRose(image, cx, cy, radius, heading);
    image.drawText(medium, Math.round(cx - medium.measureText(headingText) / 2), y, headingText, heading === null ? 150 : 255);
    if (status) {
      image.drawText(small, Math.round(cx - small.measureText(status) / 2), y + medium.lineHeight + 2, status, 125);
    }
  }
}
