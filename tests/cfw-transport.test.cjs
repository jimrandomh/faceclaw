const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CfwTransport, parseCfwAcks } = require('../.test-build/app/g2/cfw-transport.js');
const { crc16, concat, MessageReceiver } = require('../.test-build/app/g2/ble-protocol.js');
const hex = value => Buffer.from(value).toString('hex');

test('iOS transport matches Android packets including persistent compression, reset, raw fallback and ATT limits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-cfw-java-'));
  const java = name => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', name) : name;
  const random = new Uint8Array(65535); let seed = 42;
  for (let i = 0; i < random.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; random[i] = seed & 255; }
  const cases = [[100, 3, 185, new Uint8Array([6, 0, 0, 255, 255])],
    [101, 3, 185, new Uint8Array([6, 0, 0, 255, 255])], [102, 1, 20, new Uint8Array(500).fill(42)],
    'reset', [255, 3, 514, random], [103, 3, 240, new Uint8Array([11])]];
  try {
    execFileSync(java('javac'), ['-d', dir,
      path.join(__dirname, '../App_Resources/Android/src/main/java/com/faceclaw/app/g2protocol/CfwTransport.java'),
      path.join(__dirname, 'fixtures/CfwTransportVectors.java')]);
    const expected = execFileSync(java('java'), ['-cp', dir, 'com.faceclaw.app.CfwTransportVectors',
      ...cases.map(c => c === 'reset' ? c : `${c[0]}:${c[1]}:${c[2]}:${hex(c[3])}`)],
      { maxBuffer: 1024 * 1024 }).toString().trim().split('\n');
    const transport = new CfwTransport(); let index = 0;
    for (const c of cases) {
      if (c === 'reset') { transport.reset(); continue; }
      const [id, lenses, maxWrite, payload] = c, packets = transport.encode(payload, id, lenses, maxWrite);
      assert.ok(packets.every(p => p.length <= maxWrite));
      assert.equal(packets.map(hex).join(' '), expected[index++]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function ackPacket(records, lens = 1, nack = false) {
  const words = (id, ordinal, size, crc) => new Uint8Array([id, ordinal & 255, ordinal >>> 8, size & 255, size >>> 8, crc & 255, crc >>> 8]);
  const first = words(...records[0]);
  const body = concat(new Uint8Array([nack ? 3 : 1]), first.subarray(0, 3), new Uint8Array([lens]),
    first.subarray(3), ...records.slice(1).map(r => words(...r)));
  const crc = crc16(body);
  return concat(new Uint8Array([0xaa, 0x12, 50, body.length + 2, 1, 1, 0xf0, 0]), body, new Uint8Array([crc & 255, crc >>> 8]));
}
test('redundant ACKs are validated atomically and survive split/coalesced notifications', () => {
  const packet = ackPacket([[104, 0, 50, 123], [103, 0, 40, 321], [102, 0, 30, 222], [101, 0, 20, 111]], 2);
  assert.deepEqual(parseCfwAcks(packet).map(a => [a.streamId, a.lens, a.size]), [[104, 2, 50], [103, 2, 40], [102, 2, 30], [101, 2, 20]]);
  const receiver = new MessageReceiver();
  assert.deepEqual(receiver.receive('L', packet.subarray(0, 6)), []);
  const messages = receiver.receive('L', concat(packet.subarray(6), packet));
  assert.equal(messages.length, 2); assert.deepEqual(parseCfwAcks(messages[0].packet), parseCfwAcks(packet));
  for (let offset = 0; offset < packet.length; offset++) {
    const corrupt = packet.slice(); corrupt[offset] ^= 1;
    // Transport sequence byte is not covered by the ACK's CRC or identity.
    if (offset !== 2) assert.equal(parseCfwAcks(corrupt), null, `offset ${offset}`);
  }
  assert.equal(parseCfwAcks(ackPacket([[104, 0, 50, 123]], 3)), null);
  assert.equal(parseCfwAcks(ackPacket([[104, 0, 50, 123], [103, 0, 40, 321]], 1, true)), null);
  assert.equal(parseCfwAcks(ackPacket([[104, 0, 0, 0]], 1, true))[0].nack, true);
});
