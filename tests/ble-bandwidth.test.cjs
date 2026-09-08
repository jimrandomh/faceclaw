const test = require('node:test');
const assert = require('node:assert/strict');
const { BleBandwidthMeter } = require('../.test-build/app/phone-ui/ble-bandwidth-meter.js');
test('bandwidth meter matches Android units, includes control bytes and counts acknowledged frames', () => {
  const meter = new BleBandwidthMeter();
  assert.equal(meter.sample({ messages: 10, bytes: 1000, frames: 2 }, 0), 'BLE sent: 10 messages, 1,000 bytes');
  assert.equal(meter.sample({ messages: 13, bytes: 4000, frames: 4 }, 1000),
    'BLE sent: 13 messages, 4,000 bytes · 3.0 kB/s, 2.0 fps, 1,500 B/frame');
  meter.reset();
  meter.sample({ messages: 0, bytes: 0, frames: 0 }, 0);
  assert.equal(meter.sample({ messages: 1, bytes: 20, frames: 0 }, 1000), 'BLE sent: 1 messages, 20 bytes · 20 B/s, 0.0 fps');
});
test('bandwidth rates decay to zero at idle and reset over suspend/toggle/counter resets', () => {
  const meter = new BleBandwidthMeter();
  meter.sample({ messages: 0, bytes: 0, frames: 0 }, 0);
  for (let second = 1; second <= 6; second++) {
    const label = meter.sample({ messages: 10, bytes: 5000, frames: 5 }, second * 1000);
    if (second === 6) assert.match(label, /0 B\/s, 0.0 fps$/);
  }
  meter.reset();
  assert.doesNotMatch(meter.sample({ messages: 20, bytes: 9000, frames: 10 }, 20000), /fps/);
  assert.doesNotMatch(meter.sample({ messages: 0, bytes: 0, frames: 0 }, 21000), /fps/);
  assert.doesNotMatch(meter.sample({ messages: 1, bytes: 10, frames: 0 }, 30000), /fps/);
});
