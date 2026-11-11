const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { Menu } = require('../.test-build/app/ui/menu-core.js');

function load(file, deps, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports, console, ...globals, require: name => deps[name] ?? {} });
  return exports;
}

function dialog({ autoSend = false, deferred = true, synchronousFinal, isIOS = false, handsFree = false } = {}) {
  const listeners = new Set(), timers = new Map(), sent = [], refinements = [];
  let complete, timerId = 0, starts = 0, frame, speechEnd, endpointing;
  let completion = new Promise(resolve => { complete = resolve; });
  const { VoiceInputLayer } = load('app/ui/shell/voice-input.ts', {
    '../../native/voice-control': { voiceControlBridge: {
      onTranscript(cb) { listeners.add(cb); return () => listeners.delete(cb); },
      onStatus() { return () => {}; },
      onSpeechEnd(cb) { speechEnd = cb; return () => { speechEnd = null; }; },
      stop() {},
    } },
    '../../native/anthropic': { refineDictation(options) { refinements.push(options); return { cancel() {} }; } },
    '../dashboard-settings': { anthropicApiKeySetting: { get: () => 'key' } },
    '../gestures': { gestureHints: () => '' },
    './input-dialog': {
      paintInputDialog(_image, options) { frame = options; },
      createInputDialogMenu: (items, selectedIndex) => new Menu({ items, selectedIndex, wrap: true, getHeight: () => 1, draw() {} }),
    },
  }, {
    global: { isIOS },
    setTimeout(cb) { const id = ++timerId; timers.set(id, cb); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const transcript = (text, isFinal = false) => { for (const cb of [...listeners]) cb({ text, isFinal }); };
  const layer = new VoiceInputLayer({ autoSend, handsFree, onClosed() {}, dismiss: () => layer.onRemoved(),
    actions: { requestRender() {}, startVoiceCapture(value) { starts++; endpointing = value; }, stopVoiceCapture() {
      if (synchronousFinal) transcript(synchronousFinal, true);
      return deferred ? completion : undefined;
    } },
    sendTargets: [{ id: 'send', label: 'Send', onSend: text => sent.push(text) }],
  });
  layer.startCapture();
  return { layer, sent, refinements, transcript, starts: () => starts,
    endpoint: () => speechEnd?.(), endpointing: () => endpointing,
    input: type => layer.handleInput({ type }, {}),
    frame() { layer.paint({}, () => ({})); return frame; },
    timeout() { for (const [id, cb] of [...timers]) { timers.delete(id); cb(); } },
    async complete() { complete(); await completion; await Promise.resolve(); },
    nextCapture() { completion = new Promise(resolve => { complete = resolve; }); },
    timers: () => timers.size,
  };
}

for (const autoSend of [true, false]) {
  test(`iOS wakeword silence completion ${autoSend ? 'auto-sends' : 'asks for confirmation'} only after final recognition`, async () => {
    const env = dialog({ isIOS: true, handsFree: true, autoSend });
    assert.equal(env.endpointing(), true);
    env.transcript('Set a timer');
    env.endpoint(); env.timeout();
    env.input('click'); // Cannot send a partial while native recognition drains.
    assert.deepEqual(env.sent, []);
    env.transcript('Set a timer for five minutes.', true);
    await env.complete(); env.timeout();
    if (!autoSend) {
      assert.deepEqual(env.sent, []);
      env.input('click');
    }
    assert.deepEqual(env.sent, ['Set a timer for five minutes.']);
    env.endpoint(); env.timeout();
    assert.equal(env.sent.length, 1);
  });
}

for (const partial of ['', 'Set a timer']) {
  test(`auto-send waits for slow native recognition with ${partial ? 'a committed segment' : 'no partial'}`, async () => {
    const env = dialog({ autoSend: true });
    if (partial) env.transcript(partial);
    env.layer.endCapture();
    env.timeout(); // well beyond the old fallback deadline
    assert.deepEqual(env.sent, []);
    assert.equal(env.timers(), 0);
    env.transcript('Set a timer for five minutes', true);
    await env.complete(); env.timeout();
    assert.deepEqual(env.sent, ['Set a timer for five minutes']);
    assert.equal(env.timers(), 0);
  });
}

async function continuation() {
  const env = dialog();
  env.layer.endCapture();
  env.transcript('Set a timer for five minutes', true);
  await env.complete();
  env.nextCapture();
  env.input('scroll-down'); env.input('click'); // Continue
  env.input('click'); // stop follow-up
  return env;
}

test('Continue refines the complete late result instead of appending an editing instruction', async () => {
  const env = await continuation();
  env.timeout();
  assert.equal(env.refinements.length, 0);
  env.transcript('Change five to ten', true);
  await env.complete(); env.timeout();
  assert.equal(env.refinements.length, 1);
  assert.equal(env.refinements[0].original, 'Set a timer for five minutes');
  assert.equal(env.refinements[0].followup, 'Change five to ten');
});

test('Send and Continue cannot consume partial text while native recognition is pending', async () => {
  const env = dialog();
  env.transcript('Set a timer'); env.layer.endCapture();
  assert.equal(env.frame().status, 'Finishing transcription...');
  env.input('click'); env.input('scroll-down'); env.input('click');
  assert.deepEqual(env.sent, []);
  assert.equal(env.starts(), 1);
  env.transcript('Set a timer for five minutes', true); await env.complete();
  env.input('scroll-up'); env.input('click');
  assert.deepEqual(env.sent, ['Set a timer for five minutes']);
});

test('cancelling a pending continuation ignores its late transcript', async () => {
  const env = await continuation();
  env.input('double-click');
  env.transcript('Change five to ten', true); await env.complete(); env.timeout();
  assert.equal(env.refinements.length, 0);
  assert.equal(env.frame().text, 'Set a timer for five minutes');
});

test('closing while native recognition is pending never schedules a fallback or sends', async () => {
  const env = dialog({ autoSend: true });
  env.layer.endCapture(); env.layer.onRemoved();
  env.transcript('late', true); await env.complete(); env.timeout();
  assert.deepEqual(env.sent, []);
  assert.equal(env.timers(), 0);
});

test('failed or empty native captures return to the menu without sending', async () => {
  const env = dialog({ autoSend: true });
  env.layer.endCapture(); await env.complete(); env.timeout();
  assert.deepEqual(env.sent, []);
  assert.equal(env.frame().status, 'Send, continue, or discard?');
});

test('cloud fallback and a synchronous final still send exactly once', () => {
  for (const synchronousFinal of [undefined, 'complete']) {
    const env = dialog({ autoSend: true, deferred: false, synchronousFinal });
    env.transcript('partial'); env.layer.endCapture(); env.timeout();
    assert.deepEqual(env.sent, [synchronousFinal ?? 'partial']);
  }
});

/** The Android voice bridge over a fake native controller (on-device recognition only). */
function androidBridge(modules = {}) {
  const controller = {
    starts: 0,
    setListener(listener) { this.listener = listener; },
    setCommunicator() {}, setUsePhoneMic() {}, setEndpointing() {},
    setNoiseSuppression() {}, setBeamFilter() {}, clearSpeakerVerification() {}, setOnboardModelKind() {},
    start(_mode, id) { this.captureId = id; this.active = true; this.starts++; },
    stop() { this.active = false; },
    isCapturing() { return this.active; },
  };
  const { FaceclawVoiceControlBridge } = load('app/native/voice-control.ts', {
    '@nativescript/core': { Utils: { android: { getApplicationContext: () => ({}) } } },
    './speech-pause': { SpeechPauseDetector: class { reset() {} } },
    './cloud-stt-provider': { createCloudSttClient: () => null, transcriptionKey: options => options.provider },
    ...modules,
  }, { global: { isAndroid: true }, com: { faceclaw: { app: {
    FaceclawVoiceController: function () { return controller; },
    FaceclawVoiceControllerListener: function (listener) { return listener; },
  } } } });
  return { bridge: new FaceclawVoiceControlBridge(), controller };
}

test('native completion is capture-specific, follows the final, and does not wait for shared capture', async () => {
  const { bridge, controller } = androidBridge();
  const options = { provider: 'onboard-whisper' };
  const events = [];
  bridge.onTranscript(event => events.push(event.text));
  bridge.startPushToTalk(options);
  const stopped = bridge.stopPushToTalk().then(() => events.push('stopped'));
  controller.listener.onStopped(0); // an older raw/cloud capture's callback
  await Promise.resolve(); assert.deepEqual(events, []);
  controller.listener.onTranscript('complete', true);
  assert.deepEqual(events, ['complete']);
  controller.listener.onStopped(controller.captureId); await stopped;
  assert.deepEqual(events, ['complete', 'stopped']);
  bridge.startContinuousCapture(options); bridge.startPushToTalk(options);
  assert.equal(bridge.stopPushToTalk(), undefined);
  assert.equal(controller.active, true);
  bridge.stopContinuousCapture(); controller.listener.onStopped(controller.captureId);
});

test('a shared capture restarts for a holder that needs another provider, and is shared otherwise', () => {
  const { bridge, controller } = androidBridge();
  bridge.retargetContinuousCapture({ provider: 'soniox' }); // nothing continuous to retarget
  assert.equal(controller.starts, 0);
  bridge.startPushToTalk({ provider: 'onboard' });
  bridge.startContinuousCapture({ provider: 'onboard' });
  assert.equal(controller.starts, 1);
  bridge.retargetContinuousCapture({ provider: 'soniox' });
  assert.equal(controller.starts, 2);
  bridge.retargetContinuousCapture({ provider: 'soniox' });
  bridge.startPushToTalk({ provider: 'soniox' });
  assert.equal(controller.starts, 2);
  // Push-to-talk still holds the restarted stream once continuous lets go.
  bridge.stopContinuousCapture();
  assert.equal(controller.active, true);
  assert.equal(bridge.holdsCapture('ptt'), true);
});

test('Android continuous captures record to the requested WAV, and report one that cannot be created', () => {
  const recordings = [];
  let fail = false, attempts = 0;
  class FakeRecorder {
    static open(name) {
      attempts++;
      if (fail) return null;
      const r = new FakeRecorder(); r.name = name; r.path = `/Download/${name}.wav`; r.pcm = []; r.closed = false; recordings.push(r); return r;
    }
    append(pcm) { this.pcm.push(...pcm); }
    close() { this.closed = true; }
  }
  const { bridge, controller } = androidBridge({
    './wav-recorder': { WavRecorder: FakeRecorder },
    './speech-pause': { SpeechPauseDetector: class { reset() {} accept() { return false; } } },
    '../util/array-util': { toUint8Array: pcm => Uint8Array.from(pcm) },
    '../util/audio-level': { pcmLevel: () => 0 },
  });
  const options = { provider: 'onboard' };
  let changes = 0; bridge.onRecordingChange(() => changes++);
  bridge.recordTo('transcribe-1');
  assert.deepEqual([bridge.recording, bridge.recordingFailed, changes], [true, false, 1]);
  // Push-to-talk on a capture of its own is not recorded, and the file waits for audio to save.
  bridge.startPushToTalk(options);
  controller.listener.onPcm([9, 9]);
  assert.equal(attempts, 0);
  bridge.startContinuousCapture(options);
  controller.listener.onPcm([1, 2]);
  controller.listener.onPcm([3, 4]);
  assert.deepEqual(recordings.map(r => [r.name, r.pcm, r.closed]), [['transcribe-1', [1, 2, 3, 4], false]]);
  // The file outlives a capture: one restarted after the glasses reconnect keeps appending to it.
  bridge.handleSessionEnded();
  bridge.resumeCapture(options);
  controller.listener.onPcm([5]);
  assert.deepEqual(recordings.map(r => [r.pcm, r.closed]), [[[1, 2, 3, 4, 5], false]]);
  bridge.recordTo('');
  assert.deepEqual([recordings[0].closed, bridge.recording, changes], [true, false, 2]);
  controller.listener.onPcm([6]);
  assert.equal(recordings[0].pcm.length, 5);

  // One attempt per recording, not one per packet; another recording is a fresh attempt.
  fail = true; attempts = 0;
  bridge.recordTo('transcribe-2');
  controller.listener.onPcm([7]); controller.listener.onPcm([8]);
  assert.deepEqual([bridge.recording, bridge.recordingFailed, changes, attempts], [false, true, 4, 1]);
  bridge.recordTo('transcribe-2');
  controller.listener.onPcm([9]);
  assert.equal(attempts, 1);
  fail = false;
  bridge.recordTo('');
  bridge.recordTo('transcribe-2');
  controller.listener.onPcm([10]);
  assert.deepEqual([bridge.recording, bridge.recordingFailed, recordings.at(-1).pcm], [true, false, [10]]);
});
