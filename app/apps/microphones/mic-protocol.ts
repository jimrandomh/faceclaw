/**
 * Wire codec for the CFW mic_control feature (g2flash `microphone-configurations`
 * branch, EVENCFW/16, caps tokens micctl/micmc/micraw). Mirrors the contract
 * header in g2flash patches/mic_control.c:
 *
 *   field 103 (write)  ['M','C', ver, op, <9 config bytes for CONFIGURE>]
 *   field 104 (read)   21-byte ['M','C', ver, active, src, chanMask, codec,
 *                      fmt, rateLo, rateHi, brLo, brHi, flags, hwArmed,
 *                      sideId, frames u32 LE, effRateLo, effRateHi]
 *   'SM' stream frame  21-byte header ['S','M', ver, flags, seq16, tick32,
 *                      nCh, rateDiv16, fmt, codec, angleS16, ssrS16,
 *                      payLen16] + payload
 *
 * Per-temple: each arm is its own endpoint and its own 2-mic array (front
 * mic near the hinge = chanMask bit0, rear mic near the touchpad = bit1);
 * the same config goes to both temples. Stereo payloads arrive as two
 * CONCATENATED channel blocks (front then rear), not interleaved. Sessions
 * hold a 90 s lease; renew with op RENEW while streaming.
 *
 * Pure module: byte codecs only, no platform imports (the BLE plumbing lives
 * in mic-control.ts).
 */

export const MIC_PROTOCOL_VERSION = 1;
export const MIC_LEASE_MS = 90_000;

export type MicOp = "configure" | "query" | "stop" | "renew";
const OP_CODES: Record<MicOp, number> = { configure: 1, query: 2, stop: 3, renew: 4 };

export type MicSource = "codec" | "pdm";
export type MicWireCodec = "lc3" | "raw";
export type MicSampleFormat = "pcm16" | "pcm24" | "pcm32";
export type MicSide = "left" | "right";
export type MicPosition = "front" | "rear";

export const MIC_FLAG_BEAMFORM = 0x01;
/**
 * Gated: actually brings up the mic front end and streaming on the glasses.
 * The firmware validation checklist calls for confirming the tap ABI on
 * sacrificial hardware first, so the UI defaults this OFF and warns.
 */
export const MIC_FLAG_ARM_HW = 0x02;
export const SM_FLAG_TRUNCATED = 0x80;

export type MicConfig = {
  source: MicSource;
  /** bit0 = front mic, bit1 = rear mic (per temple). */
  channelMask: number;
  codec: MicWireCodec;
  format: MicSampleFormat;
  sampleRateHz: number;
  lc3BitrateBps: number;
  beamform: boolean;
  armHardware: boolean;
  /**
   * Host-side per-microphone selection. Each temple streams its full
   * front+rear stereo pair over BLE (wire channelMask stays 0b11); the phone
   * splits the concatenated channels and this mask decides which of the four
   * mics feed levels-for-use, beamforming, captions, and recording. A temple
   * with both mics off is sent STOP so its stream doesn't waste bandwidth.
   */
  hostMics: Record<MicChannelKey, boolean>;
};

/** One of the four physical microphones, as split on the host. */
export type MicChannelKey = "leftFront" | "leftRear" | "rightFront" | "rightRear";

export const MIC_CHANNEL_KEYS: readonly MicChannelKey[] = [
  "leftFront",
  "leftRear",
  "rightFront",
  "rightRear",
];

export function micChannelKey(side: MicSide, position: MicPosition): MicChannelKey {
  if (side === "left") return position === "front" ? "leftFront" : "leftRear";
  return position === "front" ? "rightFront" : "rightRear";
}

export function micChannelLabel(key: MicChannelKey): string {
  switch (key) {
    case "leftFront":
      return "L front";
    case "leftRear":
      return "L rear";
    case "rightFront":
      return "R front";
    case "rightRear":
      return "R rear";
  }
}

/** Whether a temple has any host-enabled microphone. */
export function templeActive(config: MicConfig, side: MicSide): boolean {
  return side === "left"
    ? config.hostMics.leftFront || config.hostMics.leftRear
    : config.hostMics.rightFront || config.hostMics.rightRear;
}

export function defaultMicConfig(): MicConfig {
  return {
    source: "pdm",
    channelMask: 0b11,
    codec: "raw",
    format: "pcm16",
    sampleRateHz: 16_000,
    lc3BitrateBps: 0,
    beamform: true,
    armHardware: false,
    hostMics: { leftFront: true, leftRear: true, rightFront: true, rightRear: true },
  };
}

export function micEnabled(config: MicConfig, position: MicPosition): boolean {
  return (config.channelMask & (position === "front" ? 0b01 : 0b10)) !== 0;
}

export function setMicEnabled(config: MicConfig, position: MicPosition, on: boolean): MicConfig {
  const bit = position === "front" ? 0b01 : 0b10;
  const channelMask = on ? config.channelMask | bit : config.channelMask & ~bit;
  return { ...config, channelMask };
}

const SOURCE_CODES: Record<MicSource, number> = { codec: 0, pdm: 1 };
const CODEC_CODES: Record<MicWireCodec, number> = { lc3: 0, raw: 1 };
const FORMAT_CODES: Record<MicSampleFormat, number> = { pcm16: 0, pcm24: 1, pcm32: 2 };

export function bytesPerSample(format: MicSampleFormat): number {
  return format === "pcm32" ? 4 : format === "pcm24" ? 3 : 2;
}

/** Encode the field-103 record body: ['M','C', ver, op, <payload>]. */
export function encodeMicControl(op: MicOp, config?: MicConfig): Uint8Array {
  const header = [0x4d, 0x43, MIC_PROTOCOL_VERSION, OP_CODES[op]];
  if (op !== "configure" || !config) {
    return Uint8Array.from(header);
  }
  const rate = Math.round(Math.max(8_000, Math.min(48_000, config.sampleRateHz)) / 100);
  const bitrate = Math.round(Math.max(0, Math.min(500_000, config.lc3BitrateBps)) / 100);
  const flags =
    (config.beamform ? MIC_FLAG_BEAMFORM : 0) | (config.armHardware ? MIC_FLAG_ARM_HW : 0);
  return Uint8Array.from([
    ...header,
    SOURCE_CODES[config.source],
    config.channelMask & 0b11,
    CODEC_CODES[config.codec],
    FORMAT_CODES[config.format],
    rate & 0xff,
    (rate >> 8) & 0xff,
    bitrate & 0xff,
    (bitrate >> 8) & 0xff,
    flags,
  ]);
}

export type MicStatus = {
  active: boolean;
  source: MicSource;
  channelMask: number;
  codec: MicWireCodec;
  format: MicSampleFormat;
  /** Requested rate, echoed back; the firmware always captures at 16 kHz. */
  sampleRateHz: number;
  lc3BitrateBps: number;
  beamform: boolean;
  armHardware: boolean;
  hardwareArmed: boolean;
  side: MicSide;
  framesEmitted: number;
  /** The rate actually in effect (16 kHz on current firmware). */
  effectiveRateHz: number;
};

function le16(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

function sle16(data: Uint8Array, offset: number): number {
  const value = le16(data, offset);
  return value >= 0x8000 ? value - 0x10000 : value;
}

function le32(data: Uint8Array, offset: number): number {
  return (
    (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16)) +
    data[offset + 3]! * 0x1000000
  );
}

const SOURCE_NAMES: MicSource[] = ["codec", "pdm"];
const CODEC_NAMES: MicWireCodec[] = ["lc3", "raw"];
const FORMAT_NAMES: MicSampleFormat[] = ["pcm16", "pcm24", "pcm32"];

/** Decode a field-104 status record body, or null when it isn't one. */
export function decodeMicStatus(body: Uint8Array): MicStatus | null {
  if (body.length < 21 || body[0] !== 0x4d || body[1] !== 0x43 || body[2] !== MIC_PROTOCOL_VERSION) {
    return null;
  }
  const flags = body[12]!;
  return {
    active: body[3] !== 0,
    source: SOURCE_NAMES[body[4]!] ?? "pdm",
    channelMask: body[5]! & 0b11,
    codec: CODEC_NAMES[body[6]!] ?? "lc3",
    format: FORMAT_NAMES[body[7]!] ?? "pcm16",
    sampleRateHz: le16(body, 8) * 100,
    lc3BitrateBps: le16(body, 10) * 100,
    beamform: (flags & MIC_FLAG_BEAMFORM) !== 0,
    armHardware: (flags & MIC_FLAG_ARM_HW) !== 0,
    hardwareArmed: body[13] !== 0,
    side: body[14] === 2 ? "left" : "right",
    framesEmitted: le32(body, 15),
    effectiveRateHz: le16(body, 19) * 100,
  };
}

export type MicStreamFrame = {
  /** Wraps at 2^16 (~13.6 min at ~80 fps); unwrap on the receiving side. */
  sequence: number;
  /** This temple's 1 ms OS tick — coarse L/R alignment only. */
  deviceTickMs: number;
  channelCount: number;
  sampleRateHz: number;
  format: MicSampleFormat;
  codec: MicWireCodec;
  /** On-temple TDOA bearing in signed degrees (0 unless beamform + stereo). */
  angleDegrees: number;
  /** Signal-strength ratio paired with the angle (confidence proxy). */
  ssr: number;
  truncated: boolean;
  payload: Uint8Array;
};

export const SM_HEADER_BYTES = 21;

/** Decode an 'SM' multi-channel stream frame, or null when it isn't one. */
export function decodeMicStreamFrame(data: Uint8Array): MicStreamFrame | null {
  if (
    data.length < SM_HEADER_BYTES ||
    data[0] !== 0x53 ||
    data[1] !== 0x4d ||
    data[2] !== MIC_PROTOCOL_VERSION
  ) {
    return null;
  }
  const payLen = le16(data, 19);
  const payload = data.subarray(SM_HEADER_BYTES, SM_HEADER_BYTES + payLen);
  return {
    sequence: le16(data, 4),
    deviceTickMs: le32(data, 6),
    channelCount: data[10]!,
    sampleRateHz: le16(data, 11) * 100,
    format: FORMAT_NAMES[data[13]!] ?? "pcm16",
    codec: CODEC_NAMES[data[14]!] ?? "raw",
    angleDegrees: sle16(data, 15),
    ssr: sle16(data, 17),
    truncated: (data[3]! & SM_FLAG_TRUNCATED) !== 0,
    payload,
  };
}

/**
 * Split a raw PCM16 SM payload into per-channel Float32Arrays in [-1, 1].
 * Channels arrive as CONCATENATED blocks (front then rear), matching the
 * firmware's stereo callback, which dispatches two back-to-back extraction
 * results rather than interleaving.
 */
export function splitConcatenatedPcm16(frame: MicStreamFrame): Float32Array[] | null {
  if (frame.codec !== "raw" || frame.format !== "pcm16" || frame.channelCount < 1) {
    return null;
  }
  const channels = frame.channelCount;
  const bytesPerChannel = Math.floor(frame.payload.length / channels) & ~1;
  const samplesPerChannel = bytesPerChannel / 2;
  if (samplesPerChannel <= 0) return null;
  const out: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel++) {
    const base = channel * bytesPerChannel;
    const samples = new Float32Array(samplesPerChannel);
    for (let index = 0; index < samplesPerChannel; index++) {
      const lo = frame.payload[base + index * 2]!;
      const hi = frame.payload[base + index * 2 + 1]!;
      let value = lo | (hi << 8);
      if (value >= 0x8000) value -= 0x10000;
      samples[index] = value / 32768;
    }
    out.push(samples);
  }
  return out;
}

/** The stock (non-CFW) 205-byte LC3 packet, for stream sniffing. */
export const STOCK_PACKET_BYTES = 205;

export function isStockAudioPacket(data: Uint8Array): boolean {
  return data.length === STOCK_PACKET_BYTES;
}
