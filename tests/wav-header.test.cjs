const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

test('the WAV header describes 16 kHz mono PCM16 and its data size', () => {
  const { wavHeader } = loader({ DataView }, {})('app/native/wav-header.ts');
  const header = Buffer.from(wavHeader(32000));
  assert.equal(header.length, 44);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.readUInt32LE(4), 36 + 32000);
  assert.equal(header.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(header.readUInt16LE(20), 1);
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(header.readUInt32LE(24), 16000);
  assert.equal(header.readUInt32LE(28), 32000);
  assert.equal(header.readUInt16LE(34), 16);
  assert.equal(header.toString('ascii', 36, 40), 'data');
  assert.equal(header.readUInt32LE(40), 32000);
});
