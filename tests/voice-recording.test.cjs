const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

/** The Android voice bridge over a fake native controller that records what it is told. */
function harness({ recordingOk = true, downloads = '/downloads' } = {}) {
  const controllers = [];
  class FakeController {
    constructor() {
      this.calls = []; this.events = []; this.capturing = false; this.recording = null;
      this.micArray = null; this.replay = null; this.recordingEnabled = null;
      controllers.push(this);
      // Setters the tests don't look at are only logged.
      return new Proxy(this, { get: (target, name) => name in target ? target[name] : (...args) => { target.calls.push([name, ...args]); } });
    }
    setListener(listener) { this.listener = listener; }
    setMicArray(record) { this.micArray = record; }
    setReplay(path, startMs) { this.replay = path === null ? null : { path, startMs }; }
    start(mode) { this.calls.push(['start', mode]); this.capturing = true; }
    stop() { this.calls.push(['stop']); this.capturing = false; }
    isCapturing() { return this.capturing; }
    startRecording(path, json) { if (recordingOk) this.recording = { path, info: JSON.parse(json) }; return recordingOk; }
    setRecordingEnabled(enabled) { this.recordingEnabled = enabled; }
    noteRecordingEvent(json) { this.events.push(JSON.parse(json)); }
    stopRecording() { this.calls.push(['stopRecording']); this.recording = null; return 0; }
    seekReplay(ms) { this.calls.push(['seekReplay', ms]); }
    setReplayPaused(paused) { this.calls.push(['setReplayPaused', paused]); }
  }
  const module = loader({
    global: { isAndroid: true },
    com: { faceclaw: { app: { FaceclawVoiceController: FakeController, FaceclawVoiceControllerListener: function (impl) { return impl; } } } },
  }, {
    '@nativescript/core': { Utils: { android: { getApplicationContext: () => ({}) } } },
    './cloud-stt': { toJavaBytes: bytes => Array.from(bytes) },
    './cloud-stt-provider': {
      createCloudSttClient: () => null,
      transcriptionKey: options => `${options.provider}:${options.language ?? ''}`,
    },
    './mic-recording': { newRecordingPath: name => downloads === null ? null : `${downloads}/${name}.mka` },
    '../util/array-util': { toUint8Array: value => value },
  })('app/native/voice-control.ts');
  const options = (extra = {}) => ({
    communicator: {}, provider: 'onboard', elevenLabsApiKey: '', openAiApiKey: '', sonioxApiKey: '', ...extra,
  });
  return { ...module, controllers, options, pcm: controller => controller.listener.onPcm(new Uint8Array(1600)) };
}

const CONFIGURE_2 = Uint8Array.from([0x4d, 0x43, 1, 1, 1, 1, 1, 0, 160, 0, 0, 0, 2]);
const CONFIGURE_4 = Uint8Array.from([0x4d, 0x43, 1, 1, 0, 3, 1, 0, 160, 0, 0, 0, 2]);

test('a capture of the temples\' microphones arms them, and another microphone count restarts the stream', () => {
  const h = harness();
  const bridge = h.voiceControlBridge;
  bridge.startContinuousCapture(h.options({ micArray: { configure: CONFIGURE_2 } }));
  const controller = h.controllers[0];
  assert.deepEqual(controller.micArray, Array.from(CONFIGURE_2));
  assert.equal(controller.replay, null);
  assert.deepEqual(controller.calls.filter(call => call[0] === 'start'), [['start', 'onboard']]);
  // Push-to-talk asks for the same thing while the window is open: it shares the stream.
  bridge.startPushToTalk(h.options({ micArray: { configure: CONFIGURE_2 } }));
  assert.equal(controller.calls.filter(call => call[0] === 'start').length, 1);
  bridge.stopPushToTalk();
  // The Microphones setting changed.
  bridge.retargetContinuousCapture(h.options({ micArray: { configure: CONFIGURE_4 } }));
  assert.deepEqual(controller.micArray, Array.from(CONFIGURE_4));
  assert.deepEqual(controller.calls.filter(call => call[0] === 'start' || call[0] === 'stop').map(call => call[0]), ['start', 'stop', 'start']);
  // Back to the mixed stream; the phone's microphone never gets an array.
  bridge.retargetContinuousCapture(h.options());
  assert.equal(controller.micArray, null);
  bridge.retargetContinuousCapture(h.options({ communicator: null, usePhoneMic: true, micArray: { configure: CONFIGURE_4 } }));
  assert.equal(controller.micArray, null);
});

test('a recording opens with the first audio, describes its capture, and follows the capture across restarts', () => {
  const h = harness();
  const bridge = h.voiceControlBridge;
  const changes = [];
  bridge.onRecordingChange(() => changes.push(bridge.recording));
  bridge.recordTo('transcribe-1');
  assert.equal(bridge.recording, true);
  bridge.startContinuousCapture(h.options({ micArray: { configure: CONFIGURE_4 }, noiseSuppression: true, captureInfo: { mics: 4, glasses: 'G2' } }));
  const controller = h.controllers[0];
  // Nothing on disk until audio arrives: a capture that never starts leaves no file.
  assert.equal(controller.recording, null);
  assert.equal(controller.recordingEnabled, true);
  h.pcm(controller);
  assert.equal(controller.recording.path, '/downloads/transcribe-1.mka');
  const info = controller.recording.info;
  assert.equal(info.recording, 'transcribe-1');
  assert.equal(info.source, 'glasses');
  assert.equal(info.micArray, true);
  assert.equal(info.mics, 4);
  assert.equal(info.glasses, 'G2');
  assert.deepEqual(info.transcription, { provider: 'onboard', language: '' });
  assert.deepEqual(info.processing, { noiseSuppression: true, beamFilter: null });
  h.pcm(controller);
  assert.equal(controller.calls.filter(call => call[0] === 'stopRecording').length, 0);

  // The capture restarts with other microphones: the same file goes on, with the change noted in it.
  bridge.retargetContinuousCapture(h.options({ captureInfo: { mics: 1, glasses: 'G2' } }));
  assert.equal(controller.events.length, 1);
  assert.equal(controller.events[0].event, 'capture');
  assert.equal(controller.events[0].mics, 1);
  assert.equal(controller.events[0].micArray, false);
  assert.equal(controller.recording.path, '/downloads/transcribe-1.mka');

  // Save Recording was turned off.
  bridge.recordTo('');
  assert.equal(bridge.recording, false);
  assert.equal(controller.recording, null);
  assert.deepEqual(changes, [true, false]);
});

test('push-to-talk on a capture of its own is not recorded', () => {
  const h = harness();
  const bridge = h.voiceControlBridge;
  bridge.recordTo('transcribe-1');
  bridge.startPushToTalk(h.options());
  const controller = h.controllers[0];
  assert.equal(controller.recordingEnabled, false);
  h.pcm(controller);
  assert.equal(controller.recording, null);
  // The Transcribe window joins the running stream: from here it is recorded.
  bridge.startContinuousCapture(h.options());
  assert.equal(controller.recordingEnabled, true);
  h.pcm(controller);
  assert.equal(controller.recording.path, '/downloads/transcribe-1.mka');
  bridge.stopContinuousCapture();
  assert.equal(controller.recordingEnabled, false);
});

test('a recording that cannot be created is reported once', () => {
  for (const h of [harness({ recordingOk: false }), harness({ downloads: null })]) {
    const bridge = h.voiceControlBridge;
    bridge.recordTo('transcribe-1');
    bridge.startContinuousCapture(h.options());
    h.pcm(h.controllers[0]);
    assert.equal(bridge.recording, false);
    assert.equal(bridge.recordingFailed, true);
  }
});

test('a replay runs on its own controller, follows its events, jumps while playing and restarts after the end', () => {
  const h = harness();
  const replay = new h.VoiceReplay('/downloads/talk.mka', () => h.options({ communicator: {}, micArray: { configure: CONFIGURE_4 } }));
  const seen = [];
  replay.onChange(jumpedToMs => seen.push([replay.state, replay.positionMs, jumpedToMs]));
  assert.equal(h.controllers.length, 0);
  replay.start();
  // The microphone's bridge has not been touched.
  assert.equal(h.controllers.length, 1);
  const controller = h.controllers[0];
  assert.deepEqual(controller.replay, { path: '/downloads/talk.mka', startMs: 0 });
  assert.equal(controller.micArray, null);
  assert.equal(replay.state, 'opening');
  const statuses = [];
  replay.events.onStatus(state => statuses.push(state.status));
  assert.equal(statuses.at(-1), 'Opening the recording...');

  controller.listener.onReplay('start', 0, 60_000);
  assert.equal(replay.state, 'playing');
  assert.equal(replay.durationMs, 60_000);
  controller.listener.onReplay('position', 1000, 60_000);
  assert.equal(replay.positionMs, 1000);
  // A plain start and the ticking position are not jumps.
  assert.deepEqual(seen.map(entry => entry[2]), [undefined, undefined, undefined]);

  replay.setPaused(true);
  assert.equal(replay.state, 'paused');
  replay.setPaused(false);
  replay.jumpTo(90_000); // past the end: held to the recording's length
  assert.deepEqual(controller.calls.filter(call => call[0] === 'seekReplay' || call[0] === 'setReplayPaused'),
    [['setReplayPaused', true], ['setReplayPaused', false], ['seekReplay', 60_000]]);
  replay.jumpTo(30_000);
  controller.listener.onReplay('seek', 30_000, 60_000);
  assert.deepEqual(seen.at(-1), ['playing', 30_000, 30_000]);

  controller.listener.onReplay('end', 60_000, 60_000);
  controller.capturing = false;
  assert.equal(replay.state, 'ended');
  assert.equal(replay.positionMs, 60_000);
  replay.setPaused(true); // nothing to pause
  assert.equal(replay.state, 'ended');

  // A jump once it has ended plays again from there.
  replay.jumpTo(45_000);
  assert.deepEqual(controller.replay, { path: '/downloads/talk.mka', startMs: 45_000 });
  assert.equal(replay.state, 'opening');
  controller.listener.onReplay('start', 45_000, 60_000);
  assert.deepEqual(seen.at(-1), ['playing', 45_000, 45_000]);

  replay.close();
  assert.equal(controller.calls.at(-1)[0], 'stop');
  replay.start();
  assert.equal(controller.calls.at(-1)[0], 'stop');
});

test('a recording that cannot be opened fails the replay', () => {
  const h = harness();
  const replay = new h.VoiceReplay('/downloads/missing.mka', () => h.options());
  replay.start();
  const controller = h.controllers[0];
  controller.listener.onStatus('Could not open the recording: no such file');
  controller.listener.onReplay('error', 0, 0);
  assert.equal(replay.state, 'failed');
  const statuses = [];
  replay.events.onStatus(state => statuses.push(state.status));
  assert.deepEqual(statuses, ['Could not open the recording: no such file']);
});
