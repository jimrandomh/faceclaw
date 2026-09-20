const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../.test-build/app/g2/ble-protocol.js');
const { StockConnection, OTA_WRITE, OTA_NOTIFY, decodeOtaAcks } = require('../.test-build/app/g2/stock-connection.js');
const { firmwareCrc, validateFirmware, flashLensImage } = require('../.test-build/app/g2/firmware-ota.js');
const { createFlashPrompt, flashPromptSelection } = require('../.test-build/app/g2/flash-prompt-protocol.js');
const hex = bytes => Buffer.from(bytes).toString('hex');
function fixture() {
  const sizes = [9000, 20, 20, 20, 20], image = new Uint8Array(0x40 + 5 * 16 + sizes.reduce((n, size) => n + size + 128, 0));
  const view = new DataView(image.buffer), u32 = (off, value) => view.setUint32(off, value, true);
  u32(8, 5); let offset = 0x40 + 5 * 16;
  sizes.forEach((size, index) => {
    u32(0x40 + index * 16 + 4, offset); u32(offset + 8, size);
    image.set(Buffer.from(index ? `ota/part${index}.bin` : 'ota/s200_firmware_ota.bin'), offset + 48);
    image.fill(index + 1, offset + 128, offset + 128 + size);
    if (!index) { u32(offset + 128, size); u32(offset + 128 + 0x14, 0x00438000); }
    const crc = firmwareCrc(image.subarray(offset + 128, offset + 128 + size));
    u32(offset + 12, crc); u32(0x40 + index * 16 + 12, crc); offset += size + 128;
  });
  return image;
}
class Transport {
  listeners = new Set(); writes = []; messages = []; chunks = []; seq = 0; held = false; respond = null; closed = [];
  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(event) { for (const fn of this.listeners) fn(event); }
  async resolveDevices() { return { left: 'L', right: 'R' }; }
  async connect() { return { characteristics: [p.G2_WRITE, p.G2_NOTIFY, OTA_WRITE, OTA_NOTIFY], maxWrite: 60 }; }
  async subscribe() {}
  stopScan() {}
  disconnect(id) { this.closed.push(id); this.emit({ kind: 'disconnected', identifier: id }); }
  notify(id, sid, payload, characteristic = p.G2_NOTIFY, flag = 0) {
    this.emit({ kind: 'notification', identifier: id, characteristic, data: hex(p.concat(...p.frameMessage(payload, sid, flag, 10))) });
  }
  async write(id, characteristic, bytes) {
    this.writes.push({ id, characteristic, bytes });
    if (bytes[5] === 1) this.chunks = [];
    this.chunks.push(bytes.subarray(8));
    if (bytes[5] !== bytes[4]) return;
    const all = p.concat(...this.chunks), payload = all.slice(0, -2);
    assert.equal(p.crc16(payload), all.at(-2) | all.at(-1) << 8);
    const message = { id, characteristic, sid: bytes[6], seq: bytes[2], payload };
    this.messages.push(message);
    if (this.respond) return this.respond(message);
    if (this.held) return;
    if (characteristic === OTA_WRITE) {
      if (message.sid === 0xc0 && payload[0] === 2) { this.seq = message.seq; return; }
      if (message.sid === 0xc1) assert.equal(message.seq, this.seq, 'marker/data sequence must match');
      this.notify(id, 0xc0, new Uint8Array([message.sid === 0xc1 ? 2 : payload[0], 0]), OTA_NOTIFY);
    } else {
      this.notify(id, message.sid, p.concat(p.integer(1, p.readInteger(payload, 1)), p.integer(2, p.readInteger(payload, 2)), p.bytes(3, new Uint8Array())));
    }
  }
}
async function connection(t, transport = new Transport()) {
  const link = new StockConnection(transport); t.after(() => link.close());
  await link.resolve({ left: 'a', right: 'b', ring: '' }); await link.connect('left', true);
  return { link, transport };
}

test('OTA validator checks CRCs, bounds, overlap and the main-app preamble before transfer', () => {
  const image = fixture(), segments = validateFirmware(image);
  assert.equal(segments.length, 5);
  const corrupt = image.slice(); corrupt[segments[0].offset + 200] ^= 1;
  assert.throws(() => validateFirmware(corrupt), /CRC32C/);
  assert.throws(() => validateFirmware(image.slice(0, -1)), /truncated/);
  const bad = image.slice(), view = new DataView(bad.buffer);
  view.setUint32(0x44, 0xfffffff0, true); assert.throws(() => validateFirmware(bad), /bounds/);
  const overlap = image.slice(); new DataView(overlap.buffer).setUint32(0x54, segments[0].offset, true);
  assert.throws(() => validateFirmware(overlap), /overlap/);
  const wrongLoad = image.slice(), w = new DataView(wrongLoad.buffer), main = segments[0];
  w.setUint32(main.offset + 128 + 0x14, 0, true);
  const crc = firmwareCrc(wrongLoad.subarray(main.offset + 128, main.offset + 128 + main.size));
  w.setUint32(main.offset + 12, crc, true); w.setUint32(0x4c, crc, true);
  assert.throws(() => validateFirmware(wrongLoad), /preamble/);
});

test('OTA framing streams every verified byte in 4KB blocks with shared marker/data sequences', async t => {
  const { link, transport } = await connection(t); await link.authenticate('left');
  const image = fixture(), segments = validateFirmware(image), progress = [];
  await flashLensImage(link, 'left', image, segments, value => progress.push(value), () => {}, async () => {});
  const controls = transport.messages.filter(m => m.sid === 0xc0);
  assert.equal(controls[0].payload[0], 0);
  assert.equal(controls.filter(m => m.payload[0] === 1).length, 5);
  assert.equal(controls.filter(m => m.payload[0] === 3).length, 5);
  const streamed = p.concat(...transport.messages.filter(m => m.sid === 0xc1).map(m => m.payload));
  assert.deepEqual(streamed, p.concat(...segments.map(s => image.slice(s.offset + 128, s.offset + 128 + s.size))));
  assert.equal(progress.at(-1).bytesSent, progress.at(-1).bytesTotal);
  assert.ok(transport.writes.every(w => w.bytes.length <= 60));
});

test('OTA retries NAKed blocks and failed END verification, but never accepts a rejected FILE_CHECK', async () => {
  const image = fixture(), segments = validateFirmware(image); let blockAttempts = 0, endAttempts = 0, checks = 0;
  const fake = { check() {}, async exchange(_role, _sid, payload, _match, _timeout, _write, _notify, _flag, _seq, data) {
    const op = payload[0]; let status = 0;
    if (op === 1) checks++;
    if (op === 2 && ++blockAttempts === 1) status = 1;
    if (op === 3 && ++endAttempts === 1) status = 2;
    return { payload: new Uint8Array([op, status]) };
  } };
  await flashLensImage(fake, 'left', image, segments, () => {}, () => {}, async () => {});
  assert.equal(checks, 6); assert.equal(blockAttempts, 11);
  let dataWrites = 0;
  fake.exchange = async (_role, _sid, payload, ...args) => { if (args.at(-1)) dataWrites++; return { payload: new Uint8Array([payload[0], payload[0] === 1 ? 4 : 0]) }; };
  await assert.rejects(flashLensImage(fake, 'left', image, segments, () => {}, () => {}, async () => {}), /failed after 3 attempts/);
  assert.equal(dataWrites, 0);
});

test('onboarding requests ignore wrong peers, magic and pre-encryption authentication failures', async t => {
  const { link, transport } = await connection(t); let resolved = false;
  transport.respond = message => {
    const magic = p.readInteger(message.payload, 2);
    const good = p.concat(p.integer(1, 4), p.integer(2, magic), p.bytes(3, new Uint8Array()));
    transport.notify('stranger', p.SID.auth, good);
    transport.notify('R', p.SID.auth, good);
    transport.notify('L', p.SID.auth, p.concat(p.integer(1, 4), p.integer(2, magic), p.bytes(3, p.integer(1, 1))));
    transport.notify('L', p.SID.auth, p.concat(p.integer(1, 4), p.integer(2, magic + 1), p.bytes(3, new Uint8Array())));
    setImmediate(() => { assert.equal(resolved, false); transport.notify('L', p.SID.auth, good); });
  };
  await link.authenticate('left'); resolved = true;
});

test('OTA ACK parsing rejects bad CRC and truncation; cancellation rejects an outstanding transaction', async t => {
  const { link, transport } = await connection(t); transport.held = true;
  const payload = new Uint8Array([2, 0]), packet = p.frameMessage(payload, 0xc0, 0, 1)[0];
  assert.equal(decodeOtaAcks(packet)[0].payload[1], 0);
  assert.deepEqual(decodeOtaAcks(packet.slice(0, -1)), []);
  packet[8] ^= 1; assert.deepEqual(decodeOtaAcks(packet), []);
  const pending = link.exchange('left', 0xc0, new Uint8Array([0]), m => m.command === 0, 8000, OTA_WRITE, OTA_NOTIFY, 0);
  link.close(); await assert.rejects(pending, /Cancelled/);
  assert.equal(transport.listeners.size, 0);
});

test('stock confirmation keeps No first and accepts only a confirmed flashmenu selection', () => {
  const page = createFlashPrompt(42, 'Warning'); const body = p.readBytes(page, 3);
  const list = p.readBytes(body, 2), label = p.readBytes(body, 3);
  assert.equal(p.readInteger(list, 3), 280); assert.equal(p.readInteger(label, 4), 130);
  assert.equal(p.readString(list, 10), 'flashmenu'); assert.equal(p.readString(label, 12), 'Warning');
  const event = (index, type = 0, name = 'flashmenu') => ({ sid: 0xe0, flag: 1,
    payload: p.bytes(13, p.bytes(1, p.concat(p.bytes(2, new Uint8Array(Buffer.from(name))), p.integer(4, index), p.integer(5, type)))) });
  assert.equal(flashPromptSelection(event(0)), false); assert.equal(flashPromptSelection(event(1)), true);
  assert.equal(flashPromptSelection(event(1, 1)), null); assert.equal(flashPromptSelection(event(1, 0, 'other')), null);
});
