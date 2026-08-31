import { GrayImage } from "../../graphics/image";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GESTURE_CLICK, GESTURE_DOUBLE_CLICK, GESTURE_SCROLL, type InputEvent } from "../../ui/gestures";
import { Layer, type LayerContext } from "../../ui/layers";
import { micSession, type MicSessionState } from "./mic-session";
import { dotBrightness } from "./radar-dots";

/**
 * The Sonic Radar: a top-down view around the wearer's head. The shaded
 * wedge is the listening beam (scroll rotates it, click locks it onto the
 * detected talker); the bright tick is the live direction-of-arrival from
 * the glasses DSP; speaker dots mark who was last heard where, labeled with
 * the speaker id or their name once tagged. With a compass heading the whole
 * scene is world-anchored (an N tick marks north and dots stay put as the
 * head turns); dots glow full-bright while their speaker is talking and fade
 * with the time since they last spoke.
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
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const state = this.state;

    const centerX = (width / 2) | 0;
    const centerY = ((height - 24) / 2 + 6) | 0;
    const radius = Math.min(centerX - 90, ((height - 40) / 2) | 0);

    image.drawText(font, 12, 6, "Sonic Radar", 220);
    const modeText = state.mode === "extended" ? "4-mic array" : "firmware DoA";
    image.drawText(font, width - font.measureText(modeText) - 12, 6, modeText, 110);

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
    image.drawText(font, centerX - (font.measureText("front") / 2) | 0, centerY - radius - 14, "front", 90);

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
      const labelX = dotX + 8 + font.measureText(label) > width ? dotX - font.measureText(label) - 8 : dotX + 8;
      image.drawText(font, labelX, dotY - 6, label, labelValue);
    }

    // Side panel: beam + level readouts.
    const panelX = width - 116;
    let panelY = 26;
    image.drawText(
      font,
      panelX,
      panelY,
      state.headingDeg !== null ? `Heading ${Math.round(state.headingDeg)}°` : "No compass",
      state.headingDeg !== null ? 150 : 90,
    );
    panelY += 16;
    image.drawText(font, panelX, panelY, `Beam ${Math.round(state.beamWorldDeg)}°`, 170);
    panelY += 16;
    image.drawText(font, panelX, panelY, `Width ${Math.round(state.beamWidthDeg)}°`, 130);
    panelY += 16;
    image.drawText(font, panelX, panelY, state.beamLocked ? "Locked on talker" : "Manual aim", 130);
    panelY += 16;
    if (state.doaDeviceDeg !== null) {
      image.drawText(font, panelX, panelY, `Heard ${Math.round(state.doaDeviceDeg)}°`, 200);
      panelY += 16;
    }
    image.drawText(font, panelX, panelY, state.beamFilterOn ? "Filter: beam only" : "Filter: off", 130);

    const footerY = height - font.lineHeight - 4;
    image.drawText(
      font,
      12,
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
