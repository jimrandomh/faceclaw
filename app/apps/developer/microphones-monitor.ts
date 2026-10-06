import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { GrayImage } from "../../graphics/image";
import { clamp } from "../../util/numeric-util";
import {
  addAudioMonitorListeners,
  audioMonitorCommunicator,
  isFaceclawAudioCaptureActive,
  type AudioArm,
} from "../../native/audio-monitor";
import { micArrayController } from "../microphones/mic-control";
import {
  MIC_RET_NONE,
  STOCK_PACKET_BYTES,
  decodeMicStatus,
  decodeMicStreamFrame,
  splitInterleavedPcm16,
  type MicStatus,
  type MicStreamFrame,
} from "../microphones/mic-protocol";
import { GESTURE_DOUBLE_CLICK, type InputEvent } from "../../ui/gestures";
import { type MenuItem } from "../../ui/menu";
import { Layer, type LayerContext } from "../../ui/layers";
import { shell } from "../../ui/shell/shell";

// Packet rate / byte rate / largest gap are measured over this trailing window.
const RATE_WINDOW_MS = 2_000;
// Activity strip: packet counts per bucket over the last HISTORY_MS.
const HISTORY_MS = 20_000;
const BUCKET_MS = 500;
const BUCKETS = HISTORY_MS / BUCKET_MS;
// Repaint cadence; also how often a replaced communicator is re-subscribed.
const TICK_MS = 250;
// Stock packet trailer (see Lc3PacketFramer.kt): SSR, angle, counter.
const STOCK_SSR_OFFSET = 200;
const STOCK_ANGLE_OFFSET = 202;
const STOCK_COUNTER_OFFSET = 204;
// Counter gaps at or beyond this are late/duplicate copies, not losses.
const STOCK_LATE_GAP = 128;
const LEVEL_FLOOR_DB = -90;

// wallMs (JS receipt time) windows the rates; arrivalMs (the session core's
// elapsed-realtime stamp, taken on the BLE thread) measures gaps without the
// main-thread hop's jitter.
type Arrival = { wallMs: number; arrivalMs: number; bytes: number };

type ArmStats = {
  packets: number;
  stockPackets: number;
  smPackets: number;
  otherPackets: number;
  lastOtherBytes: number;
  lastArrivalWallMs: number | null;
  recent: Arrival[];
  buckets: number[];
  stockCounter: number | null;
  stockLost: number;
  stockDuplicate: number;
  stockAngle: number;
  stockSsr: number;
  frame: MicStreamFrame | null;
  smSeq: number | null;
  smSeqGaps: number;
  channelDb: number[];
  status: MicStatus | null;
  statusAtMs: number | null;
};

function emptyStats(): ArmStats {
  return {
    packets: 0,
    stockPackets: 0,
    smPackets: 0,
    otherPackets: 0,
    lastOtherBytes: 0,
    lastArrivalWallMs: null,
    recent: [],
    buckets: Array.from({ length: BUCKETS }, () => 0),
    stockCounter: null,
    stockLost: 0,
    stockDuplicate: 0,
    stockAngle: 0,
    stockSsr: 0,
    frame: null,
    smSeq: null,
    smSeqGaps: 0,
    channelDb: [],
    status: null,
    statusAtMs: null,
  };
}

/**
 * Passive microphone monitor: shows what the glasses are sending on the
 * audio characteristic, per temple, without enabling anything. Open it, then
 * activate the mics from another app (Microphones, Transcribe, voice input)
 * and come back: collection continues while this page is hidden, so the
 * counters and the 20 s activity strip show whether that activation produced
 * a stream, what kind (stock mono LC3 or CFW 'SM' frames), and how healthy it
 * is. CFW mic_control status records are shown when they arrive: after a
 * CONFIGURE, with the periodic battery read, or from this window's "Query mic
 * status" menu item (a status request only; it touches no mic hardware).
 * Only the right temple can send status; each lens's debug overlay shows its
 * own counters.
 */
export class MicrophonesMonitorLayer implements Layer {
  private readonly stats: Record<"L" | "R", ArmStats> = { L: emptyStats(), R: emptyStats() };
  private unknownArmPackets = 0;
  private bucketStartMs = Date.now();
  private communicator: any = null;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private removed = false;

  constructor(
    private readonly windowId: string,
    private readonly requestRender: () => void,
    private readonly onClosed: () => void = () => {},
  ) {
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  onRemoved(): void {
    this.removed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.communicator = null;
    this.onClosed();
  }

  private tick(): void {
    if (this.removed) return;
    const communicator = audioMonitorCommunicator();
    if (communicator !== this.communicator) {
      this.unsubscribe?.();
      this.communicator = communicator;
      this.unsubscribe = addAudioMonitorListeners(
        communicator,
        (data, arm, arrivalMs) => this.onPacket(data, arm, arrivalMs),
        (body, arm) => this.onStatus(body, arm),
      );
    }
    this.advanceBuckets(Date.now());
    if (shell.isWindowVisible(this.windowId)) this.requestRender();
  }

  private advanceBuckets(nowMs: number): void {
    while (nowMs - this.bucketStartMs >= BUCKET_MS) {
      this.bucketStartMs += BUCKET_MS;
      for (const stats of Object.values(this.stats)) {
        stats.buckets.shift();
        stats.buckets.push(0);
      }
    }
  }

  private onPacket(data: Uint8Array, arm: AudioArm, arrivalMs: number): void {
    if (this.removed) return;
    if (arm === "?") {
      this.unknownArmPackets++;
      return;
    }
    const stats = this.stats[arm];
    const nowMs = Date.now();
    this.advanceBuckets(nowMs);
    stats.packets++;
    stats.buckets[BUCKETS - 1]!++;
    stats.recent.push({ wallMs: nowMs, arrivalMs, bytes: data.length });
    stats.lastArrivalWallMs = nowMs;

    const frame = decodeMicStreamFrame(data);
    if (frame) {
      this.onStreamFrame(stats, frame);
    } else if (data.length === STOCK_PACKET_BYTES) {
      this.onStockPacket(stats, data);
    } else {
      stats.otherPackets++;
      stats.lastOtherBytes = data.length;
    }
  }

  private onStockPacket(stats: ArmStats, data: Uint8Array): void {
    stats.stockPackets++;
    const counter = data[STOCK_COUNTER_OFFSET]!;
    if (stats.stockCounter !== null) {
      const gap = (counter - stats.stockCounter) & 0xff;
      if (gap === 0 || gap >= STOCK_LATE_GAP) {
        stats.stockDuplicate++;
        return;
      }
      stats.stockLost += gap - 1;
    }
    stats.stockCounter = counter;
    stats.stockSsr = readS16(data, STOCK_SSR_OFFSET);
    stats.stockAngle = readS16(data, STOCK_ANGLE_OFFSET);
  }

  private onStreamFrame(stats: ArmStats, frame: MicStreamFrame): void {
    stats.smPackets++;
    if (stats.smSeq !== null && frame.sequence !== ((stats.smSeq + 1) & 0xffff)) stats.smSeqGaps++;
    stats.smSeq = frame.sequence;
    stats.frame = frame;
    const channels = splitInterleavedPcm16(frame);
    stats.channelDb = channels ? channels.map(rmsDb) : [];
  }

  private onStatus(body: Uint8Array, arm: AudioArm): void {
    if (this.removed || arm === "?") return;
    const status = decodeMicStatus(body);
    if (!status) return;
    this.stats[arm].status = status;
    this.stats[arm].statusAtMs = Date.now();
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const line = font.lineHeight;
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const nowMs = Date.now();

    image.drawText(font, 16, 5, "Microphones (passive)", 230);
    const capture = isFaceclawAudioCaptureActive() ? "Faceclaw capture: on" : "Faceclaw capture: off";
    image.drawText(font, width - 16 - font.measureText(capture), 5, capture, 170);

    if (!this.communicator) {
      image.drawText(font, 16, 5 + line * 2, "Glasses not connected.", 190);
      image.drawText(font, 16, height - 16, `${GESTURE_DOUBLE_CLICK} back`, 110);
      return image;
    }

    const gutter = 16;
    const columnWidth = Math.floor((width - gutter * 3) / 2);
    const stripHeight = 22;
    const top = 5 + line + 6;
    const bottom = height - 16 - stripHeight - 8;
    this.paintArm(image, "L", "Left", gutter, top, columnWidth, bottom, nowMs);
    this.paintArm(image, "R", "Right", gutter * 2 + columnWidth, top, columnWidth, bottom, nowMs);

    const stripY = height - 16 - stripHeight - 4;
    const stripMax = Math.max(1, ...this.stats.L.buckets, ...this.stats.R.buckets);
    drawStrip(image, this.stats.L.buckets, gutter, stripY, columnWidth, stripHeight, stripMax);
    drawStrip(image, this.stats.R.buckets, gutter * 2 + columnWidth, stripY, columnWidth, stripHeight, stripMax);

    const footer = this.unknownArmPackets > 0
      ? `last ${HISTORY_MS / 1000} s   unattributed packets ${this.unknownArmPackets}`
      : `packets per ${BUCKET_MS} ms, last ${HISTORY_MS / 1000} s`;
    image.drawText(font, gutter, height - 16, footer, 110);
    const back = `${GESTURE_DOUBLE_CLICK} back   tap reset`;
    image.drawText(font, width - gutter - font.measureText(back), height - 16, back, 110);
    return image;
  }

  private paintArm(
    image: GrayImage,
    arm: "L" | "R",
    label: string,
    x: number,
    top: number,
    width: number,
    bottom: number,
    nowMs: number,
  ): void {
    const font = getDefaultSmallFont();
    const line = font.lineHeight;
    const stats = this.stats[arm];
    const cutoff = nowMs - RATE_WINDOW_MS;
    while (stats.recent.length > 0 && stats.recent[0]!.wallMs < cutoff) stats.recent.shift();
    const rate = (stats.recent.length * 1000) / RATE_WINDOW_MS;
    const byteRate = stats.recent.reduce((sum, arrival) => sum + arrival.bytes, 0) / RATE_WINDOW_MS;
    let maxGap = 0;
    for (let i = 1; i < stats.recent.length; i++) {
      maxGap = Math.max(maxGap, stats.recent[i]!.arrivalMs - stats.recent[i - 1]!.arrivalMs);
    }

    const rows: Array<[string, number]> = [];
    const streaming = stats.recent.length > 0;
    rows.push([`${label}: ${streaming ? `${rate.toFixed(1)} pkt/s  ${byteRate.toFixed(1)} kB/s` : "silent"}`, streaming ? 235 : 150]);
    const age = stats.lastArrivalWallMs === null ? "never" : `${formatAge(nowMs - stats.lastArrivalWallMs)} ago`;
    rows.push([`last ${age}${streaming && stats.recent.length > 1 ? `  max gap ${maxGap} ms` : ""}`, 170]);
    rows.push([`total ${stats.packets}: stock ${stats.stockPackets}  SM ${stats.smPackets}  other ${stats.otherPackets}${stats.otherPackets ? ` (${stats.lastOtherBytes} B)` : ""}`, 170]);
    if (stats.stockPackets > 0) {
      rows.push([`stock LC3: lost ${stats.stockLost}  dup ${stats.stockDuplicate}`, 190]);
      rows.push([`  angle ${stats.stockAngle}°  ssr ${stats.stockSsr}`, 170]);
    }
    const frame = stats.frame;
    if (frame) {
      const flags = [frame.truncated ? "trunc" : "", stats.smSeqGaps ? `seq gaps ${stats.smSeqGaps}` : ""].filter(Boolean).join("  ");
      rows.push([`SM: ${frame.channelCount}ch ${frame.sampleRateHz / 1000} kHz ${frame.codec} ${frame.payload.length} B ${flags}`, 190]);
      rows.push([`  angle ${frame.angleDegrees}°  ssr ${frame.ssr}`, 170]);
    }
    const status = stats.status;
    if (status) {
      const armed = status.hardwareArmed ? "armed" : status.active ? "configured" : "inactive";
      rows.push([`CFW ${armed}: ${status.source} mask ${status.channelMask} frames ${status.framesEmitted}`, 190]);
      rows.push([`  ${status.codec} ${status.effectiveRateHz / 1000} kHz  ${formatAge(nowMs - (stats.statusAtMs ?? nowMs))} ago`, 150]);
      const diag = status.diagnostics;
      if (diag) {
        rows.push([`  tap ${diag.tapCalls} calls  last ${diag.tapLastBytes} B @slot ${diag.tapLastSlot}`, 190]);
        rows.push([`  skip idle ${diag.skipIdle} lease ${diag.skipLease} alloc ${diag.skipAlloc}`, 170]);
        rows.push([
          `  reg ${formatRet(diag.registerResult)} unreg ${formatRet(diag.unregisterResult)} ntf ${formatRet(diag.notifyResult)}  slots ${diag.slots.map(formatSlot).join("")}  lease ${diag.leaseRemainingS} s`,
          170,
        ]);
      } else {
        rows.push(["  (no tap diagnostics: older firmware)", 120]);
      }
    } else {
      rows.push(["CFW status: none seen", 120]);
    }

    let y = top;
    for (const [text, shade] of rows) {
      if (y + line > bottom) return;
      image.drawText(font, x, y, fitText(font, text, width), shade);
      y += line;
    }
    // Per-channel RMS level bars for raw PCM frames.
    for (let channel = 0; channel < stats.channelDb.length; channel++) {
      if (y + line > bottom) return;
      const db = stats.channelDb[channel]!;
      const tag = `ch${channel} ${db <= LEVEL_FLOOR_DB ? "-inf" : db.toFixed(0)} dB`;
      image.drawText(font, x, y, tag, 190);
      const barX = x + font.measureText("ch0 -100 dB") + 6;
      const barWidth = Math.max(0, width - (barX - x));
      const fill = Math.round(clamp((db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB, 0, 1) * barWidth);
      image.drawRect(barX, y + 3, barWidth, line - 6, 60);
      if (fill > 0) image.fillRect(barX, y + 3, fill, line - 6, db > -3 ? 255 : 170);
      y += line;
    }
  }

  /** Window context-menu entries while this page is open. */
  menuItems(): MenuItem[] {
    return [
      {
        label: "Query mic status",
        onSelect: (ctx) => {
          micArrayController.query();
          ctx.stack.pop();
        },
      },
      {
        label: "Reset counters",
        onSelect: (ctx) => {
          this.resetCounters();
          ctx.stack.pop();
        },
      },
    ];
  }

  private resetCounters(): void {
    this.stats.L = emptyStats();
    this.stats.R = emptyStats();
    this.unknownArmPackets = 0;
    this.requestRender();
  }

  async handleInput(event: InputEvent, ctx: LayerContext): Promise<void> {
    if (event.type === "double-click") {
      ctx.stack.pop();
    } else if (event.type === "click") {
      this.resetCounters();
    }
  }
}

function formatRet(value: number): string {
  return value === MIC_RET_NONE ? "-" : String(value);
}

/** Same letters as the firmware overlay: - empty, S another callback, T our tap. */
function formatSlot(state: "empty" | "other" | "tap"): string {
  return state === "tap" ? "T" : state === "other" ? "S" : "-";
}

function readS16(data: Uint8Array, offset: number): number {
  const value = data[offset]! | (data[offset + 1]! << 8);
  return value >= 0x8000 ? value - 0x10000 : value;
}

function rmsDb(samples: Float32Array): number {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
  return rms > 0 ? Math.max(LEVEL_FLOOR_DB, 20 * Math.log10(rms)) : LEVEL_FLOOR_DB;
}

function formatAge(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function fitText(font: ReturnType<typeof getDefaultSmallFont>, text: string, width: number): string {
  if (font.measureText(text) <= width) return text;
  let end = text.length;
  while (end > 0 && font.measureText(`${text.slice(0, end)}…`) > width) end--;
  return `${text.slice(0, end)}…`;
}

function drawStrip(
  image: GrayImage,
  buckets: readonly number[],
  x: number,
  y: number,
  width: number,
  height: number,
  max: number,
): void {
  image.drawRect(x, y, width, height, 45);
  const barWidth = width / buckets.length;
  for (let i = 0; i < buckets.length; i++) {
    const count = buckets[i]!;
    if (count <= 0) continue;
    const barHeight = Math.max(1, Math.round((count / max) * (height - 2)));
    const left = x + Math.floor(i * barWidth);
    const right = x + Math.floor((i + 1) * barWidth) - 1;
    image.fillRect(left + 1, y + height - 1 - barHeight, Math.max(1, right - left), barHeight, 200);
  }
}
