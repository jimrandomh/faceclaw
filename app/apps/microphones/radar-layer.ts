import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { micSession, type MicSessionState } from "./mic-session";
import { dotBrightness } from "./radar-dots";

/** Room above the plot's ring for its "front" label. */
const FRONT_LABEL_BAND = 14;
/** Gap between the ring and the hint line under it. */
const RING_FOOTER_GAP = 10;
/** The least the ring keeps clear of the window's sides, which leaves the readout panel its corner. */
const RING_SIDE_CLEARANCE = 90;
/** The readout panel: the least its column is wide, and its drop below the title's top. */
const PANEL_MIN_WIDTH = 104;
const PANEL_OFFSET_Y = 20;

/**
 * The Sonic Radar: a top-down view around the wearer's head. The shaded
 * wedge is the listening beam (scroll rotates it, click locks it onto the
 * detected talker); the bright tick is the live direction-of-arrival from
 * the glasses DSP; speaker dots mark who was last heard where, labeled with
 * the speaker id or their name once tagged. With a compass heading the whole
 * scene is world-anchored (an N tick marks north and dots stay put as the
 * head turns); dots glow full-bright while their speaker is talking and fade
 * with the time since they last spoke.
 *
 * The plot is centred on the window, between the title row and the hint
 * line; those and the readout panel keep to the padding suggested for the
 * window's edges.
 */
export class RadarLayer implements Layer {
  private state: MicSessionState = micSession.getState();
  private unsubscribe: (() => void) | null = null;

  start(requestRender: () => void): void {
    this.unsubscribe = micSession.onState((state) => {
      this.state = state;
      requestRender();
    });
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height, padding } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const state = this.state;

    const footerY = height - padding.bottom - font.lineHeight;
    const ringTop = padding.top + FRONT_LABEL_BAND;
    const ringBottom = footerY - RING_FOOTER_GAP;
    const centerX = (width / 2) | 0;
    const centerY = ((ringTop + ringBottom) / 2) | 0;
    const radius = Math.max(0, Math.min(centerX - RING_SIDE_CLEARANCE, ((ringBottom - ringTop) / 2) | 0));

    image.drawText(font, padding.left, padding.top, "Sonic Radar", 220);
    const modeText = state.mode === "extended" ? "4-mic array" : "firmware DoA";
    image.drawText(font, width - padding.right - font.measureText(modeText), padding.top, modeText, 110);

    // Beam wedge (device frame; the head is the reference for display).
    const beamDeviceDeg = this.deviceBeamDeg(state);
    const halfWidth = state.beamWidthDeg / 2;
    if (state.beamFilterOn || state.beamLocked) {
      for (let offset = -halfWidth; offset <= halfWidth; offset += 1.5) {
        const angle = ((beamDeviceDeg + offset - 90) * Math.PI) / 180;
        image.drawLine(
          centerX,
          centerY,
          centerX + Math.round(Math.cos(angle) * radius),
          centerY + Math.round(Math.sin(angle) * radius),
          26,
        );
      }
    }
    // Beam edges stay visible even when the fill is off.
    for (const edge of [-halfWidth, halfWidth]) {
      const angle = ((beamDeviceDeg + edge - 90) * Math.PI) / 180;
      image.drawLine(
        centerX,
        centerY,
        centerX + Math.round(Math.cos(angle) * radius),
        centerY + Math.round(Math.sin(angle) * radius),
        70,
      );
    }

    // Radar rings.
    drawCircle(image, centerX, centerY, radius, 60);
    drawCircle(image, centerX, centerY, (radius / 2) | 0, 30);
    image.drawText(font, centerX - (font.measureText("front") / 2) | 0, centerY - radius - FRONT_LABEL_BAND, "front", 90);

    // Compass north tick: anchors the world frame visually as the head turns.
    if (state.headingDeg !== null) {
      const northAngle = ((this.worldToDeviceDeg(0, state) - 90) * Math.PI) / 180;
      const cos = Math.cos(northAngle);
      const sin = Math.sin(northAngle);
      image.drawLine(
        centerX + Math.round(cos * (radius - 6)),
        centerY + Math.round(sin * (radius - 6)),
        centerX + Math.round(cos * (radius + 2)),
        centerY + Math.round(sin * (radius + 2)),
        200,
      );
      image.drawText(
        font,
        centerX + Math.round(cos * (radius + 10)) - ((font.measureText("N") / 2) | 0),
        centerY + Math.round(sin * (radius + 10)) - ((font.lineHeight / 2) | 0),
        "N",
        200,
      );
    }

    // Head marker.
    image.fillRoundedRect(centerX - 4, centerY - 5, 8, 10, 160, 3);

    // Live direction-of-arrival tick.
    if (state.doaDeviceDeg !== null && state.ssr > 0) {
      const angle = ((state.doaDeviceDeg - 90) * Math.PI) / 180;
      const tipX = centerX + Math.cos(angle) * radius;
      const tipY = centerY + Math.sin(angle) * radius;
      image.drawLine(
        centerX + Math.round(Math.cos(angle) * (radius * 0.55)),
        centerY + Math.round(Math.sin(angle) * (radius * 0.55)),
        Math.round(tipX),
        Math.round(tipY),
        255,
      );
    }

    // Speaker dots with id/name labels: full-bright (and ringed) while that
    // person is actively speaking, fading with silence age otherwise.
    const now = Date.now();
    for (const dot of state.speakerDots) {
      const deviceDeg = this.worldToDeviceDeg(dot.worldAngleDeg, state);
      const angle = ((deviceDeg - 90) * Math.PI) / 180;
      const dotX = centerX + Math.round(Math.cos(angle) * radius * 0.8);
      const dotY = centerY + Math.round(Math.sin(angle) * radius * 0.8);
      const value = dotBrightness(dot, now);
      if (dot.speaking) {
        image.fillRoundedRect(dotX - 4, dotY - 4, 9, 9, value, 4);
        drawCircle(image, dotX, dotY, 7, 140);
      } else {
        image.fillRoundedRect(dotX - 3, dotY - 3, 7, 7, value, 3);
      }
      const label = dot.name;
      const labelValue = Math.max(90, value - 50);
      const labelX = dotX + 8 + font.measureText(label) > width - padding.right ? dotX - font.measureText(label) - 8 : dotX + 8;
      image.drawText(font, labelX, dotY - 6, label, labelValue);
    }

    // Side panel: beam + level readouts, in a column that ends at the right
    // edge's padding and is wide enough for its longest line.
    const panelLines: Array<[text: string, value: number]> = [
      state.headingDeg !== null ? [`Heading ${Math.round(state.headingDeg)}°`, 150] : ["No compass", 90],
      [`Beam ${Math.round(state.beamWorldDeg)}°`, 170],
      [`Width ${Math.round(state.beamWidthDeg)}°`, 130],
      [state.beamLocked ? "Locked on talker" : "Manual aim", 130],
    ];
    if (state.doaDeviceDeg !== null) panelLines.push([`Heard ${Math.round(state.doaDeviceDeg)}°`, 200]);
    panelLines.push([state.beamFilterOn ? "Filter: beam only" : "Filter: off", 130]);
    const panelWidth = Math.max(PANEL_MIN_WIDTH, ...panelLines.map(([text]) => Math.ceil(font.measureText(text))));
    const panelX = width - padding.right - panelWidth;
    let panelY = padding.top + PANEL_OFFSET_Y;
    for (const [text, value] of panelLines) {
      image.drawText(font, panelX, panelY, text, value);
      panelY += 16;
    }

    image.drawText(
      font,
      padding.left,
      footerY,
      `${GESTURE_SCROLL} aim   ${GESTURE_CLICK} lock   ${GESTURE_DOUBLE_CLICK} back`,
      110,
    );
    return image;
  }

  private deviceBeamDeg(state: MicSessionState): number {
    if (state.headingDeg === null) return state.beamWorldDeg;
    return normalize(state.beamWorldDeg - state.headingDeg);
  }

  private worldToDeviceDeg(worldDeg: number, state: MicSessionState): number {
    if (state.headingDeg === null) return normalize(worldDeg);
    return normalize(worldDeg - state.headingDeg);
  }

  handleInput(event: InputEvent, ctx: LayerContext): void {
    switch (event.type) {
      case "scroll-up":
        micSession.setBeamWorldDeg(this.state.beamWorldDeg - 15);
        return;
      case "scroll-down":
        micSession.setBeamWorldDeg(this.state.beamWorldDeg + 15);
        return;
      case "click":
        micSession.toggleBeamLock();
        return;
      case "long-press":
        micSession.adjustBeamWidth(30 * (this.state.beamWidthDeg >= 180 ? -5 : 1));
        return;
      case "double-click":
        ctx.stack.pop();
        return;
      default:
        return;
    }
  }

  onRemoved(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

function normalize(deg: number): number {
  let value = deg % 360;
  if (value > 180) value -= 360;
  if (value < -180) value += 360;
  return value;
}

function drawCircle(image: GrayImage, centerX: number, centerY: number, radius: number, value: number): void {
  const steps = Math.max(48, radius * 4);
  for (let step = 0; step < steps; step++) {
    const angle = (step / steps) * 2 * Math.PI;
    image.setPixel(
      centerX + Math.round(Math.cos(angle) * radius),
      centerY + Math.round(Math.sin(angle) * radius),
      value,
    );
  }
}
