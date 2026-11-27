const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

/**
 * The Android voice bridge over a fake native controller and cloud provider,
 * with a clock and timers the tests run by hand.
 */
function harness() {
  const controllers = [], clients = [], timers = new Map();
  let timerId = 0, now = 1_000_000;
  class FakeController {
    constructor() {
      this.calls = []; this.capturing = false; this.captureId = 0;
      controllers.push(this);
      // Setters the tests don't look at are only logged.
      return new Proxy(this, { get: (target, name) => name in target ? target[name] : (...args) => { target.calls.push([name, ...args]); } });
    }
    setListener(listener) { this.listener = listener; }
    start(mode, captureId) { this.calls.push(['start', mode]); this.captureId = captureId; this.capturing = true; }
    stop() { this.calls.push(['stop']); this.capturing = false; }
    isCapturing() { return this.capturing; }
    /** The native capture ended without being stopped: the glasses dropped the mic, say. */
    die(captureId = this.captureId) { this.capturing = false; this.listener.onStopped(captureId); }
    count(name) { return this.calls.filter(call => call[0] === name).length; }
  }
  class FakeDate extends Date { static now() { return now; } }
  const module = loader({
    global: { isAndroid: true },
    com: { faceclaw: { app: { FaceclawVoiceController: FakeController, FaceclawVoiceControllerListener: function (impl) { return impl; } } } },
    Date: FakeDate,
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  }, {
    '@nativescript/core': { Utils: { android: { getApplicationContext: () => ({}) } } },
    './cloud-stt': { toJavaBytes: bytes => Array.from(bytes) },
    './cloud-stt-provider': {
      createCloudSttClient(options, callbacks) {
        if (options.provider !== 'soniox') return null;
        const client = { callbacks, started: 0, stopped: 0, finished: 0,
          start() { this.started++; }, stop() { this.stopped++; }, finish() { this.finished++; }, acceptPcm() {} };
        clients.push(client);
        return client;
      },
      transcriptionKey: options => `${options.provider}:${options.language ?? ''}`,
    },
    './mic-recording': { newRecordingPath: name => `/downloads/${name}.mka` },
    '../util/array-util': { toUint8Array: value => value },
  })('app/native/voice-control.ts');
  const options = (extra = {}) => ({
    communicator: {}, provider: 'onboard', elevenLabsApiKey: '', openAiApiKey: '', sonioxApiKey: '', ...extra,
  });
  return {
    ...module, controllers, clients, options,
    /** The delays of the timers waiting to fire. */
    pending: () => Array.from(timers.values(), timer => timer.ms),
    /** Fire every waiting timer, as if its delay had passed. */
    fire() { for (const [id, timer] of [...timers]) { timers.delete(id); now += timer.ms; timer.callback(); } },
    advance(ms) { now += ms; },
  };
}

test('a held capture that ends by itself is started again, later each time it fails, with the options of the moment', () => {
  const h = harness();
  const bridge = h.voiceControlBridge;
  let current = h.options({ noiseSuppression: false });
  bridge.setRestartOptions(() => current);
  const statuses = [];
  bridge.onStatus(state => statuses.push(state.status));
  bridge.startContinuousCapture(h.options());
  const controller = h.controllers[0];
  assert.equal(controller.count('start'), 1);

  // The glasses refused the mic: the worker reports and stops.
  controller.listener.onStatus('Could not start G2 microphone input.');
  controller.die();
  assert.equal(bridge.holdsCapture('continuous'), true);
  assert.equal(bridge.isCaptureLive(), false);
  assert.deepEqual(h.pending(), [1000]);
  current = h.options({ noiseSuppression: true });
  h.fire();
  assert.equal(controller.count('start'), 2);
  assert.deepEqual(controller.calls.filter(call => call[0] === 'setNoiseSuppression').map(call => call[1]), [false, true]);
  assert.equal(statuses.at(-1), 'Starting microphone...');
  assert.equal(bridge.isCaptureLive(), true);

  // It keeps failing: the waits grow, then hold at the last one.
  const waits = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    controller.die();
    waits.push(...h.pending());
    h.fire();
  }
  assert.deepEqual(waits, [2000, 5000, 10000, 30000, 30000, 30000]);
  assert.equal(controller.count('start'), 8);

  // Once it has run for a while, a failure is a new one.
  h.advance(60_000);
  controller.die();
  assert.deepEqual(h.pending(), [1000]);
});

test('nothing to capture from yet puts the restart off instead of starting on stale options', () => {
  const h = harness();
  const bridge = h.voiceControlBridge;
  let current = null;
  bridge.setRestartOptions(() => current);
  bridge.startContinuousCapture(h.options());
  const controller = h.controllers[0];
  controller.die();
  h.fire();
  assert.equal(controller.count('start'), 1);
  assert.deepEqual(h.pending(), [2000]);
  current = h.options();
  h.fire();
  assert.equal(controller.count('start'), 2);
});

test('a capture the bridge stopped itself, or replaced, is not taken for one that died', () => {
  const h = harness();
  const bridge = h.voiceControlBridge;
  bridge.startContinuousCapture(h.options());
  const controller = h.controllers[0];
  const first = controller.captureId;
  // Another provider: the stream is stopped and started again, and the first one's end arrives late.
  bridge.retargetContinuousCapture(h.options({ provider: 'onboard-whisper' }));
  assert.notEqual(controller.captureId, first);
  controller.listener.onStopped(first);
  assert.deepEqual(h.pending(), []);
  assert.equal(bridge.isCaptureLive(), true);
  assert.equal(controller.count('start'), 2);

  const second = controller.captureId;
  bridge.stopContinuousCapture();
  controller.listener.onStopped(second);
  assert.deepEqual(h.pending(), []);
  assert.equal(controller.count('start'), 2);
});

test('letting go of a dead capture, or the session ending under it, calls the restart off', () => {
  const h = harness();
  const bridge = h.voiceControlBridge;
  bridge.startContinuousCapture(h.options());
  const controller = h.controllers[0];
  controller.die();
  assert.deepEqual(h.pending(), [1000]);
  bridge.stopContinuousCapture();
  assert.deepEqual(h.pending(), []);

  bridge.startContinuousCapture(h.options());
  controller.die();
  assert.deepEqual(h.pending(), [1000]);
  bridge.handleSessionEnded();
  assert.deepEqual(h.pending(), []);
  assert.equal(bridge.hasSuspendedCapture(), true);
  // The next session starts it the usual way.
  bridge.resumeCapture(h.options());
  assert.equal(bridge.isCaptureLive(), true);
  assert.equal(controller.count('start'), 3);
});

test('a push-to-talk press on a dead capture starts the stream rather than joining it', () => {
  const h = harness();
  const bridge = h.voiceControlBridge;
  bridge.startContinuousCapture(h.options());
  const controller = h.controllers[0];
  controller.die();
  bridge.startPushToTalk(h.options());
  assert.equal(controller.count('start'), 2);
  assert.deepEqual(h.pending(), []);
  assert.equal(bridge.isCaptureLive(), true);
});

test('a cloud provider that gives up takes the stream down and has it started again', () => {
  const h = harness();
  const bridge = h.voiceControlBridge;
  const statuses = [];
  bridge.onStatus(state => statuses.push(state.status));
  bridge.startContinuousCapture(h.options({ provider: 'soniox' }));
  const controller = h.controllers[0];
  assert.equal(h.clients.length, 1);
  assert.deepEqual(controller.calls.filter(call => call[0] === 'start'), [['start', 'cloud']]);

  h.clients[0].callbacks.onError('Soniox: invalid request');
  assert.equal(statuses.at(-1), 'Soniox: invalid request');
  // The mic is no use with nothing transcribing it, and push-to-talk must not share this.
  assert.equal(controller.count('stop'), 1);
  assert.equal(bridge.isCaptureLive(), false);
  assert.deepEqual(h.pending(), [1000]);
  // The stop that follows is the bridge's own.
  controller.listener.onStopped(controller.captureId);
  assert.deepEqual(h.pending(), [1000]);

  bridge.startPushToTalk(h.options({ provider: 'soniox' }));
  assert.equal(h.clients.length, 2);
  assert.equal(h.clients[1].started, 1);
  assert.equal(controller.count('start'), 2);
  assert.deepEqual(h.pending(), []);
});

test('an error from the client of a capture already let go changes nothing', () => {
  const h = harness();
  const bridge = h.voiceControlBridge;
  bridge.startPushToTalk(h.options({ provider: 'soniox' }));
  const controller = h.controllers[0];
  bridge.stopPushToTalk();
  assert.equal(h.clients[0].finished, 1);
  h.clients[0].callbacks.onError('Soniox: no audio');
  assert.deepEqual(h.pending(), []);
  assert.equal(controller.count('start'), 1);
});

test('a push-to-talk stop that had no start leaves a continuous capture\'s cloud client alone', () => {
  const h = harness();
  const bridge = h.voiceControlBridge;
  bridge.startContinuousCapture(h.options({ provider: 'soniox' }));
  // The dialog closed before its start went through.
  bridge.stopPushToTalk();
  assert.equal(h.clients[0].finished, 0);
  assert.equal(bridge.isCaptureLive(), true);
  // With nobody holding, a dangling commit is still finished.
  bridge.stopContinuousCapture();
  bridge.stopPushToTalk();
  assert.equal(h.clients.length, 1);
});

test('the raw tap is started again for its owners, and not once they have let go', () => {
  const h = harness();
  const bridge = h.voiceControlBridge;
  const communicator = { name: 'session' };
  assert.equal(bridge.startRawCapture({ communicator, owner: 'evenhub-mic-router' }), true);
  const controller = h.controllers[0];
  controller.die();
  assert.equal(bridge.isRawCaptureLive(), false);
  assert.deepEqual(h.pending(), [1000]);
  h.fire();
  assert.equal(controller.count('start'), 2);
  assert.equal(bridge.isRawCaptureLive(), true);
  assert.equal(controller.calls.filter(call => call[0] === 'setCommunicator').at(-1)[1], communicator);

  controller.die();
  bridge.stopRawCapture('evenhub-mic-router');
  assert.deepEqual(h.pending(), []);
  assert.equal(controller.count('start'), 2);
});

test('a replay that ran out or could not be opened is not started again', () => {
  const h = harness();
  const bridge = h.voiceControlBridge;
  bridge.startContinuousCapture(h.options({ communicator: null, replay: { path: '/downloads/a.mka', startMs: 0 } }));
  const controller = h.controllers[0];
  controller.die();
  assert.deepEqual(h.pending(), []);
  assert.equal(controller.count('start'), 1);
});
