const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../.test-build/app/g2/ble-protocol.js');
const decode = (payload) => protocol.decodeGlassesInput({ sid:224,flag:1,payload });
const packet = Buffer.from('08026a151a13080e1002a2060c524901010aabcd00efcdab89','hex');

test('timestamped CFW packet decodes atomically with source and original unsigned tick', () => {
  const input = decode(packet);
  assert.equal(input.eventType,14); assert.equal(input.eventSource,2);
  assert.deepEqual(input.ringInput,{tick:0x89abcdef,type:10,aux:171,speed:205});
  for (const tick of [0,1,0xffffffff]) {
    const p = Buffer.from(packet); p.writeUInt32LE(tick,21);
    assert.equal(decode(p).ringInput.tick,tick);
  }
});
test('legacy/invalid metadata leaves input intact without inventing a clock', () => {
  assert.equal(decode(Buffer.from('08026a041a02080e','hex')).ringInput,undefined);
  for (const offset of [9,13,14,15,16,20]) {
    const p = Buffer.from(packet); p[offset]++;
    assert.equal(decode(p).ringInput,undefined);
  }
});

// Firmware regression: MsgPbTxByBle sets flag 0; Thread_MsgPbNotifyByBle
// (also used by stock SysEvent) sets flag 1. Payload validity is insufficient.
test('ring input must use the notification envelope, never the reply envelope', () => {
  assert.equal(protocol.decodeGlassesInput({ sid:224,flag:0,payload:packet }),null);
  for (const flag of [1,6]) {
    const input = protocol.decodeGlassesInput({ sid:224,flag,payload:packet });
    assert.equal(input.eventType,14); assert.equal(input.ringInput.tick,0x89abcdef);
  }
});
