const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

// The resource monitor's platform samplers, over stand-ins for the iOS
// FaceclawResourceUsage JSON and the Android FaceclawResourceUsage LongArray.
function ios(raw) {
  const load = loader({ FaceclawResourceUsage: { sample: () => JSON.stringify(raw) } });
  return load('app/native/resource-usage.ios.ts');
}

function android(raw) {
  const load = loader({ com: { faceclaw: { app: { FaceclawResourceUsage: { sample: () => raw } } } } });
  return load('app/native/resource-usage.ts');
}

test('iOS charts footprint, resident and malloc, and reports the jetsam limit, peak and thermal state', () => {
  const usage = ios({
    atMs: 5000, cpuMs: 1234.5, footprintKb: 200 * 1024, footprintPeakKb: 300 * 1024, residentKb: 150 * 1024,
    mallocKb: 64 * 1024, availableKb: 2848 * 1024, threads: 23, thermalState: 2, lowPower: true,
  });
  assert.deepEqual(Array.from(usage.MEMORY_SERIES), ['footprint', 'resident', 'malloc']);
  const sample = usage.sampleResourceUsage();
  assert.equal(sample.atMs, 5000);
  assert.equal(sample.cpuMs, 1234.5);
  assert.equal(sample.threads, 23);
  assert.deepEqual(Array.from(sample.memoryMb), [200, 150, 64]);
  assert.equal(sample.status, 'limit 3.0G · peak 300M · thermal serious · Low Power Mode');
});

test('iOS omits the limit without jetsam headroom, and fields the native query could not fill', () => {
  const sample = ios({ atMs: 1, footprintKb: 1024, thermalState: 0, lowPower: false }).sampleResourceUsage();
  assert.equal(sample.cpuMs, 0);
  assert.equal(sample.threads, 0);
  assert.deepEqual(Array.from(sample.memoryMb), [1, 0, 0]);
  assert.equal(sample.status, 'thermal nominal');
});

test('Android charts RSS, native and Java heap, and reports peak RSS and committed Java heap', () => {
  const usage = android([9000, 4321, 400 * 1024, 48 * 1024, 12 * 1024, 24 * 1024, 87, 512 * 1024]);
  assert.deepEqual(Array.from(usage.MEMORY_SERIES), ['RSS', 'native', 'Java']);
  const sample = usage.sampleResourceUsage();
  assert.equal(sample.atMs, 9000);
  assert.equal(sample.cpuMs, 4321);
  assert.equal(sample.threads, 87);
  assert.deepEqual(Array.from(sample.memoryMb), [400, 48, 12]);
  assert.equal(sample.status, 'peak RSS 512M · Java heap 24M committed');
});
