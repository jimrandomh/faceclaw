const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function harness() {
  const native = { start: () => '', cancel() { this.cancels++; }, cancels: 0, finish() { this.finished = true; }, acceptPacket: p => audio.push(p) };
  const audio = [], timers = new Map(), commands = [], text = [];
  let authorization = 3, permissionRequests = 0, release;
  const sandbox = { exports: {}, FaceclawSpeech: { new: () => native, authorizationStatus: () => authorization,
    requestAuthorization: done => { permissionRequests++; done(3); } },
    setTimeout: fn => { timers.set(fn, fn); return fn; }, clearTimeout: fn => timers.delete(fn),
    NSData: { dataWithBytesLength: (b, n) => Buffer.from(b, 0, n) }, interop: { handleof: b => b } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/native/voice-control.ios.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, sandbox);
  const bridge = new sandbox.exports.IosVoiceControlBridge();
  bridge.onTranscript(event => text.push({ ...event }));
  const session = { setMicrophone(enabled, fn) {
    commands.push(enabled);
    if (enabled) { this.packet = fn; return new Promise(resolve => { release = resolve; }); }
    return Promise.resolve();
  } };
  return { bridge, native, session, audio, commands, text, timers, release: () => release(),
    authorization: value => { authorization = value; }, permissionRequests: () => permissionRequests,
    event: event => native.eventHandler(JSON.stringify(event)) };
}
test('iOS speech permission is requested only in foreground and denial stays actionable', async () => {
  const h = harness(); h.authorization(0);
  assert.equal(await h.bridge.prepare(false), false); assert.equal(h.permissionRequests(), 0);
  assert.equal(await h.bridge.prepare(true), true); assert.equal(h.permissionRequests(), 1);
  h.authorization(2); assert.equal(await h.bridge.prepare(true), false);
  assert.match(h.bridge.statusText, /Settings/);
});
test('glasses speech sends PCM-source packets, replaces partials, and drains final text after manual release', async () => {
  const h = harness(); const start = h.bridge.startGlassesCapture(h.session, () => {});
  h.session.packet(new Uint8Array([1, 2, 3])); assert.deepEqual([...h.audio[0]], [1, 2, 3]);
  h.release(); await start;
  h.event({ kind: 'transcript', text: 'hello', final: false });
  h.event({ kind: 'transcript', text: 'hello world', final: false });
  h.bridge.stopPushToTalk(); assert.deepEqual(h.commands, [true, false]); assert.equal(h.native.finished, true);
  h.session.packet(new Uint8Array([4])); assert.equal(h.audio.length, 1);
  h.event({ kind: 'transcript', text: 'Hello world.', final: true });
  h.event({ kind: 'ended', message: 'Ready to send' });
  assert.deepEqual(h.text, [{ text: 'hello', isFinal: false }, { text: 'hello world', isFinal: false }, { text: 'Hello world.', isFinal: true }]);
  h.event({ kind: 'transcript', text: 'stale', final: true }); assert.equal(h.text.length, 3);
  assert.equal(h.timers.size, 0);
});
test('cancel and disconnect during enable cannot resurrect capture or leave its microphone listener active', async () => {
  for (const stop of ['stop', 'handleSessionEnded']) {
    const h = harness(); let ends = 0; h.bridge.onSpeechEnd(() => ends++);
    const start = h.bridge.startGlassesCapture(h.session, () => {});
    h.bridge[stop](); h.release(); await start;
    h.session.packet(new Uint8Array([9]));
    h.event({ kind: 'transcript', text: 'stale', final: true });
    assert.deepEqual(h.commands, [true, false]); assert.equal(h.audio.length, 0); assert.equal(h.text.length, 0);
    assert.equal(h.timers.size, 0); assert.equal(ends, stop === 'stop' ? 0 : 1);
  }
});
test('missing microphone data ends the session and disables the mic with an actionable status', async () => {
  const h = harness(); const start = h.bridge.startGlassesCapture(h.session, () => {}); h.release(); await start;
  for (const fn of h.timers.values()) fn();
  assert.deepEqual(h.commands, [true, false]); assert.match(h.bridge.statusText, /No microphone audio/);
});
