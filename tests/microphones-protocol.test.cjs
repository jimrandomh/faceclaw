// Pins the mic_control wire codec against the firmware contract in g2flash's
// patches/mic_control.c (microphone-configurations branch): field-103 control
// records, the 21-byte field-104 status, and the 21-byte 'SM' stream header
// with concatenated (not interleaved) channel payloads.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MIC_CHANNEL_KEYS,
  micChannelKey,
  micChannelLabel,
  templeActive,
  encodeMicControl,
  decodeMicStatus,
  decodeMicStreamFrame,
  splitConcatenatedPcm16,
  defaultMicConfig,
  micEnabled,
  setMicEnabled,
  isStockAudioPacket,
  MIC_FLAG_BEAMFORM,
  MIC_FLAG_ARM_HW,
  SM_HEADER_BYTES,
} = require("../.test-build/app/apps/microphones/mic-protocol.js");

test("configure record layout matches the firmware contract", () => {
  const config = {
    ...defaultMicConfig(),
    source: "pdm",
    channelMask: 0b11,
    codec: "raw",
    format: "pcm16",
    sampleRateHz: 16000,
    lc3BitrateBps: 32000,
    beamform: true,
    armHardware: false,
  };
  const record = encodeMicControl("configure", config);
  assert.equal(record.length, 13);
  assert.deepEqual([...record.slice(0, 4)], [0x4d, 0x43, 1, 1]); // 'M','C',ver,CONFIGURE
  assert.equal(record[4], 1); // pdm
  assert.equal(record[5], 0b11);
  assert.equal(record[6], 1); // raw
  assert.equal(record[7], 0); // pcm16
  assert.equal(record[8] | (record[9] << 8), 160); // 16000/100
  assert.equal(record[10] | (record[11] << 8), 320); // 32000/100
  assert.equal(record[12], MIC_FLAG_BEAMFORM);
});

test("ops encode as 1..4 and non-configure records carry no payload", () => {
  assert.equal(encodeMicControl("configure")[3], 1);
  assert.equal(encodeMicControl("query")[3], 2);
  assert.equal(encodeMicControl("stop")[3], 3);
  assert.equal(encodeMicControl("renew")[3], 4);
  assert.equal(encodeMicControl("query").length, 4);
});

test("sample rate clamps to the firmware's 8-48 kHz window", () => {
  const low = encodeMicControl("configure", { ...defaultMicConfig(), sampleRateHz: 1000 });
  assert.equal(low[8] | (low[9] << 8), 80);
  const high = encodeMicControl("configure", { ...defaultMicConfig(), sampleRateHz: 96000 });
  assert.equal(high[8] | (high[9] << 8), 480);
});

test("arm-hardware flag bit is 0x02", () => {
  const record = encodeMicControl("configure", { ...defaultMicConfig(), armHardware: true });
  assert.equal(record[12] & MIC_FLAG_ARM_HW, MIC_FLAG_ARM_HW);
});

function buildStatus(overrides = {}) {
  const values = {
    active: 1,
    source: 1,
    chanMask: 0b11,
    codec: 1,
    format: 0,
    rateDiv: 160,
    brDiv: 0,
    flags: 0x03,
    hwArmed: 1,
    sideId: 2,
    frames: 123456,
    effRateDiv: 160,
    ...overrides,
  };
  const body = new Uint8Array(21);
  body[0] = 0x4d;
  body[1] = 0x43;
  body[2] = 1;
  body[3] = values.active;
  body[4] = values.source;
  body[5] = values.chanMask;
  body[6] = values.codec;
  body[7] = values.format;
  body[8] = values.rateDiv & 0xff;
  body[9] = values.rateDiv >> 8;
  body[10] = values.brDiv & 0xff;
  body[11] = values.brDiv >> 8;
  body[12] = values.flags;
  body[13] = values.hwArmed;
  body[14] = values.sideId;
  body[15] = values.frames & 0xff;
  body[16] = (values.frames >> 8) & 0xff;
  body[17] = (values.frames >> 16) & 0xff;
  body[18] = (values.frames >> 24) & 0xff;
  body[19] = values.effRateDiv & 0xff;
  body[20] = values.effRateDiv >> 8;
  return body;
}

test("status decode: sides, rates, frames, flags", () => {
  const status = decodeMicStatus(buildStatus());
  assert.ok(status);
  assert.equal(status.active, true);
  assert.equal(status.source, "pdm");
  assert.equal(status.side, "left"); // sideId 2 = left
  assert.equal(status.sampleRateHz, 16000);
  assert.equal(status.effectiveRateHz, 16000);
  assert.equal(status.framesEmitted, 123456);
  assert.equal(status.beamform, true);
  assert.equal(status.armHardware, true);
  assert.equal(decodeMicStatus(buildStatus({ sideId: 1 })).side, "right");
});

test("status decode rejects short or foreign records", () => {
  assert.equal(decodeMicStatus(buildStatus().slice(0, 19)), null);
  const wrongMagic = buildStatus();
  wrongMagic[0] = 0x58;
  assert.equal(decodeMicStatus(wrongMagic), null);
});

function buildSmFrame({ channels = 2, samplesPerChannel = 4, angle = -30, ssr = 500, truncated = false } = {}) {
  const payLen = channels * samplesPerChannel * 2;
  const data = new Uint8Array(SM_HEADER_BYTES + payLen);
  data[0] = 0x53;
  data[1] = 0x4d;
  data[2] = 1;
  data[3] = 0x01 | (truncated ? 0x80 : 0);
  data[4] = 0x39;
  data[5] = 0x05; // seq 1337
  data[6] = 0xa0;
  data[7] = 0x86;
  data[8] = 0x01;
  data[9] = 0x00; // tick 100000
  data[10] = channels;
  data[11] = 160 & 0xff;
  data[12] = 0;
  data[13] = 0; // pcm16
  data[14] = 1; // raw
  const angleU = angle < 0 ? angle + 0x10000 : angle;
  data[15] = angleU & 0xff;
  data[16] = angleU >> 8;
  data[17] = ssr & 0xff;
  data[18] = ssr >> 8;
  data[19] = payLen & 0xff;
  data[20] = payLen >> 8;
  // Channel blocks are CONCATENATED: channel 0 all-1000s, channel 1 all-(-2000)s.
  for (let c = 0; c < channels; c++) {
    const value = c === 0 ? 1000 : -2000;
    const unsigned = value < 0 ? value + 0x10000 : value;
    for (let s = 0; s < samplesPerChannel; s++) {
      const base = SM_HEADER_BYTES + c * samplesPerChannel * 2 + s * 2;
      data[base] = unsigned & 0xff;
      data[base + 1] = unsigned >> 8;
    }
  }
  return data;
}

test("SM frame decode: header fields and negative angle", () => {
  const frame = decodeMicStreamFrame(buildSmFrame());
  assert.ok(frame);
  assert.equal(frame.sequence, 1337);
  assert.equal(frame.deviceTickMs, 100000);
  assert.equal(frame.channelCount, 2);
  assert.equal(frame.sampleRateHz, 16000);
  assert.equal(frame.codec, "raw");
  assert.equal(frame.angleDegrees, -30);
  assert.equal(frame.ssr, 500);
  assert.equal(frame.truncated, false);
  assert.equal(frame.payload.length, 16);
  assert.equal(decodeMicStreamFrame(buildSmFrame({ truncated: true })).truncated, true);
});

test("SM payload splits as concatenated channel blocks", () => {
  const frame = decodeMicStreamFrame(buildSmFrame({ samplesPerChannel: 3 }));
  const channels = splitConcatenatedPcm16(frame);
  assert.ok(channels);
  assert.equal(channels.length, 2);
  assert.equal(channels[0].length, 3);
  for (const sample of channels[0]) assert.ok(Math.abs(sample - 1000 / 32768) < 1e-6);
  for (const sample of channels[1]) assert.ok(Math.abs(sample - -2000 / 32768) < 1e-6);
});

test("stock packets are recognized by their fixed 205-byte size", () => {
  assert.equal(isStockAudioPacket(new Uint8Array(205)), true);
  assert.equal(isStockAudioPacket(new Uint8Array(204)), false);
  assert.equal(decodeMicStreamFrame(new Uint8Array(205)), null);
});

test("host-side mic selection: four channels, temple activity derived", () => {
  assert.equal(MIC_CHANNEL_KEYS.length, 4);
  assert.equal(micChannelKey("left", "front"), "leftFront");
  assert.equal(micChannelKey("right", "rear"), "rightRear");
  assert.equal(micChannelLabel("leftRear"), "L rear");
  const config = defaultMicConfig();
  assert.equal(templeActive(config, "left"), true);
  config.hostMics = { leftFront: false, leftRear: false, rightFront: true, rightRear: false };
  assert.equal(templeActive(config, "left"), false);
  assert.equal(templeActive(config, "right"), true);
});

test("channel mask helpers target front bit0 / rear bit1", () => {
  let config = { ...defaultMicConfig(), channelMask: 0b01 };
  assert.equal(micEnabled(config, "front"), true);
  assert.equal(micEnabled(config, "rear"), false);
  config = setMicEnabled(config, "rear", true);
  assert.equal(config.channelMask, 0b11);
  config = setMicEnabled(config, "front", false);
  assert.equal(config.channelMask, 0b10);
});
