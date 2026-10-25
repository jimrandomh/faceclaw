const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function harness() {
  const native = { startWithEndpointing(endpointing) { this.endpointing = endpointing; return ''; }, startPhoneWithEndpointing(endpointing) { this.endpointing = endpointing; this.phone = true; return this.error ?? ''; },
    startPcmCaptureWithEndpointingPhone(endpointing, phone) { this.pcmCapture = { endpointing, phone }; return this.error ?? ''; },
    cancel() { this.cancels++; }, cancels: 0, finish() { this.finished = true; }, acceptPacket: p => audio.push(p) };
  const audio = [], timers = new Map(), commands = [], text = [], clouds = [];
  // Stands in for cloud-stt-provider: any provider but "onboard" is a keyed cloud one.
  const provider = {
    usesCloudStt: voice => voice.provider !== 'onboard',
    createCloudSttClient(voice, options, continuous) {
      if (voice.provider === 'onboard') return null;
      const client = { options, continuous, pcm: [], started: false, finished: 0, stopped: false,
        start() { this.started = true; }, acceptPcm(bytes) { this.pcm.push([...bytes]); },
        finish() { this.finished++; }, stop() { this.stopped = true; } };
      clouds.push(client); return client;
    },
  };
  const recordings = [];
  class FakeRecorder {
    static open(name) { const r = new FakeRecorder(); r.name = name; r.path = `/Downloads/${name}.wav`; r.pcm = []; r.closed = false; recordings.push(r); return r; }
    append(bytes) { this.pcm.push(...bytes); }
    close() { this.closed = true; }
  }
  let authorization = 3, microphoneAuthorization = 3, microphoneRequests = 0, permissionRequests = 0, release;
  const sandbox = { exports: {}, FaceclawSpeech: { new: () => native, authorizationStatus: () => authorization,
    requestAuthorization: done => { permissionRequests++; done(3); },
    microphoneAuthorizationStatus: () => microphoneAuthorization,
    requestMicrophoneAuthorization: done => { microphoneRequests++; done(3); } },
    setTimeout: fn => { timers.set(fn, fn); return fn; }, clearTimeout: fn => timers.delete(fn),
    NSData: { dataWithBytesLength: (b, n) => Buffer.from(b, 0, n) }, interop: { handleof: b => b, bufferFromData: d => d },
    require: name => name === './cloud-stt-provider' ? provider : name === './wav-recorder.ios' ? { WavRecorder: FakeRecorder } : {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/native/voice-control.ios.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, sandbox);
  const bridge = new sandbox.exports.IosVoiceControlBridge();
  bridge.onTranscript(event => text.push({ ...event }));
  const session = { setMicrophone(enabled, fn) {
    commands.push(enabled);
    if (enabled) { this.packet = fn; return new Promise(resolve => { release = resolve; }); }
    return Promise.resolve();
  } };
  const onboard = { provider: 'onboard', elevenLabsApiKey: '', openAiApiKey: '', sonioxApiKey: '' };
  return { bridge, native, session, audio, commands, text, timers, clouds, recordings, release: () => release(),
    onboard, cloud: { ...onboard, provider: 'soniox', sonioxApiKey: 'key' },
    microphoneAuthorization: value => { microphoneAuthorization = value; }, microphoneRequests: () => microphoneRequests,
    authorization: value => { authorization = value; }, permissionRequests: () => permissionRequests,
    event: event => native.eventHandler(JSON.stringify(event)) };
}
test('iOS speech permission is requested only in foreground and denial stays actionable', async () => {
  const h = harness(); h.authorization(0);
  assert.equal(await h.bridge.prepare(false, false, h.onboard), false); assert.equal(h.permissionRequests(), 0);
  assert.equal(await h.bridge.prepare(true, false, h.onboard), true); assert.equal(h.permissionRequests(), 1);
  h.authorization(2); assert.equal(await h.bridge.prepare(true, false, h.onboard), false);
  assert.match(h.bridge.statusText, /Settings/);
});
test('glasses speech sends PCM-source packets, replaces partials, and drains final text after manual release', async () => {
  const h = harness(); const start = h.bridge.startGlassesCapture(h.session, h.onboard, () => {});
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
    const start = h.bridge.startGlassesCapture(h.session, h.onboard, () => {});
    h.bridge[stop](); h.release(); await start;
    h.session.packet(new Uint8Array([9]));
    h.event({ kind: 'transcript', text: 'stale', final: true });
    assert.deepEqual(h.commands, [true, false]); assert.equal(h.audio.length, 0); assert.equal(h.text.length, 0);
    assert.equal(h.timers.size, 0); assert.equal(ends, stop === 'stop' ? 0 : 1);
  }
});
test('missing microphone data ends the session and disables the mic with an actionable status', async () => {
  const h = harness(); const start = h.bridge.startGlassesCapture(h.session, h.onboard, () => {}); h.release(); await start;
  for (const fn of h.timers.values()) fn();
  assert.deepEqual(h.commands, [true, false]); assert.match(h.bridge.statusText, /No microphone audio/);
});

test('hands-free endpointing releases the microphone and waits for the final transcript before completing', async () => {
  const h = harness(); let ends = 0, completed = false;
  h.bridge.onSpeechEnd(() => ends++);
  const start = h.bridge.startGlassesCapture(h.session, h.onboard, () => {}, true); h.release(); await start;
  assert.equal(h.native.endpointing, true);
  h.event({ kind: 'transcript', text: 'Set a timer', final: false });
  h.event({ kind: 'finishing' });
  const completion = h.bridge.stopPushToTalk().then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false); assert.equal(ends, 1);
  assert.deepEqual(h.commands, [true, false]);
  h.event({ kind: 'transcript', text: 'Set a timer for five minutes.', final: true });
  h.event({ kind: 'ended' }); await completion;
  assert.equal(completed, true);
  assert.equal(h.text.at(-1).text, 'Set a timer for five minutes.');
  const manual = h.bridge.startGlassesCapture(h.session, h.onboard, () => {}); h.release(); await manual;
  assert.equal(h.native.endpointing, false);
  const cancelled = h.bridge.stopPushToTalk(); h.bridge.stop(); await cancelled;
});

test('phone microphone permission is requested only for foreground preview capture', async () => {
  const h = harness(); h.microphoneAuthorization(0);
  assert.equal(await h.bridge.prepare(true, false, h.onboard), true);
  assert.equal(h.microphoneRequests(), 0, 'glasses input does not need phone microphone permission');
  assert.equal(await h.bridge.prepare(false, true, h.onboard), false);
  assert.equal(h.microphoneRequests(), 0);
  assert.equal(await h.bridge.prepare(true, true, h.onboard), true);
  assert.equal(h.microphoneRequests(), 1);
  h.microphoneAuthorization(2);
  assert.equal(await h.bridge.prepare(true, true, h.onboard), false);
  assert.match(h.bridge.statusText, /Microphone.*Settings/);
});

test('phone capture forwards endpointing and drains final text without touching Bluetooth', async () => {
  const h = harness();
  await h.bridge.startPhoneCapture(h.onboard, () => {}, true);
  assert.equal(h.native.phone, true); assert.equal(h.native.endpointing, true);
  h.bridge.handleSessionEnded();
  h.event({ kind: 'transcript', text: 'First line\nSecond line', final: false });
  assert.equal(h.text.length, 1, 'BLE state changes must not stop phone capture');
  h.event({ kind: 'finishing' });
  let finished = false;
  const completion = h.bridge.stopPushToTalk().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  h.bridge.handleSessionEnded();
  h.event({ kind: 'transcript', text: 'First line\nSecond line.', final: true });
  h.event({ kind: 'ended' }); await completion;
  assert.equal(h.text.at(-1).text, 'First line\nSecond line.');
  assert.deepEqual(h.commands, []);
});

test('background cleanup stops phone capture but preserves glasses capture', async () => {
  const h = harness(); let ends = 0; h.bridge.onSpeechEnd(() => ends++);
  await h.bridge.startPhoneCapture(h.onboard, () => {});
  h.bridge.stopPhoneCapture();
  assert.equal(ends, 1);
  h.event({ kind: 'transcript', text: 'stale', final: true }); assert.equal(h.text.length, 0);
  const start = h.bridge.startGlassesCapture(h.session, h.onboard, () => {}); h.release(); await start;
  h.bridge.stopPhoneCapture();
  h.event({ kind: 'transcript', text: 'on glasses', final: false });
  assert.equal(h.text.at(-1).text, 'on glasses');
  h.bridge.stop();
});

test('phone microphone startup errors end capture with an actionable status', async () => {
  const h = harness(); let ends = 0; h.bridge.onSpeechEnd(() => ends++);
  h.native.error = 'No phone microphone is available.';
  await h.bridge.startPhoneCapture(h.onboard, () => {});
  assert.equal(ends, 1); assert.match(h.bridge.statusText, /No phone microphone/);
  await h.bridge.stopPushToTalk();
});

test('a cloud provider needs no Speech Recognition permission, but phone capture still needs the microphone', async () => {
  const h = harness(); h.authorization(0); h.microphoneAuthorization(0);
  assert.equal(await h.bridge.prepare(false, false, h.cloud), true);
  assert.equal(await h.bridge.prepare(false, true, h.cloud), false);
  assert.equal(await h.bridge.prepare(true, true, h.cloud), true);
  assert.equal(h.permissionRequests(), 0); assert.equal(h.microphoneRequests(), 1);
});

test('glasses cloud capture streams native PCM and completes on the final after the drained audio', async () => {
  const h = harness();
  const start = h.bridge.startGlassesCapture(h.session, h.cloud, () => {});
  assert.deepEqual({ ...h.native.pcmCapture }, { endpointing: false, phone: false });
  const client = h.clouds[0]; assert.equal(client.started, true);
  client.options.onStatus('Listening (Soniox)...');
  h.session.packet(new Uint8Array([1, 2])); assert.equal(h.audio.length, 1, 'LC3 still decodes natively');
  h.release(); await start;
  h.native.pcmHandler(new Uint8Array([5, 6]).buffer);
  h.event({ kind: 'audio', seconds: 1, packets: 20, rms: 0.1, missing: 0, errors: 0 });
  assert.equal(h.bridge.statusText, 'Listening (Soniox)...', 'the provider status stays up');
  client.options.onTranscript({ text: 'hello', isFinal: false });
  let done = false;
  const completion = h.bridge.stopPushToTalk().then(() => { done = true; });
  assert.deepEqual(h.commands, [true, false]); assert.equal(h.native.finished, true);
  h.event({ kind: 'finishing' });
  assert.equal(client.finished, 0, 'commit waits for the native audio to drain');
  h.native.pcmHandler(new Uint8Array([7]).buffer);
  h.event({ kind: 'ended', message: 'Ready to send' });
  assert.deepEqual(client.pcm, [[5, 6], [7]]); assert.equal(client.finished, 1);
  await Promise.resolve(); assert.equal(done, false);
  client.options.onTranscript({ text: 'Hello there.', isFinal: true });
  await completion;
  assert.equal(client.stopped, true); assert.equal(h.bridge.statusText, 'Ready to send');
  assert.deepEqual(h.text, [{ text: 'hello', isFinal: false }, { text: 'Hello there.', isFinal: true }]);
  assert.equal(h.timers.size, 0);
});

test('cloud capture times out a missing final, keeps native errors, and ends on provider errors', async () => {
  const h = harness();
  await h.bridge.startPhoneCapture(h.cloud, () => {}, true);
  assert.deepEqual({ ...h.native.pcmCapture }, { endpointing: true, phone: true });
  const completion = h.bridge.stopPushToTalk();
  h.event({ kind: 'ended', message: 'Phone microphone interrupted.' });
  assert.equal(h.clouds[0].finished, 1); assert.equal(h.timers.size, 1);
  for (const fn of [...h.timers.values()]) fn();
  await completion;
  assert.equal(h.clouds[0].stopped, true); assert.equal(h.bridge.statusText, 'Phone microphone interrupted.');

  let ends = 0; h.bridge.onSpeechEnd(() => ends++);
  await h.bridge.startPhoneCapture(h.cloud, () => {});
  h.clouds[1].options.onError('Soniox: Invalid API key');
  assert.equal(h.clouds[1].stopped, true); assert.equal(ends, 1);
  assert.match(h.bridge.statusText, /Invalid API key/);
  h.clouds[1].options.onTranscript({ text: 'stale', isFinal: true });
  assert.equal(h.text.length, 0);

  h.native.error = 'No phone microphone is available.';
  await h.bridge.startPhoneCapture(h.cloud, () => {});
  assert.equal(h.clouds[2].started, false, 'no connection without audio');
  assert.match(h.bridge.statusText, /No phone microphone/);
});

test('continuous capture needs a cloud provider, shares its mic with push-to-talk, and drains pause segments on stop', async () => {
  const h = harness(); let ends = 0; h.bridge.onSpeechEnd(() => ends++);
  assert.equal(h.bridge.supportsContinuous(h.onboard), false);
  assert.equal(h.bridge.supportsContinuous(h.cloud), true);
  const start = h.bridge.startGlassesCapture(h.session, h.cloud, () => {}, false, true); h.release(); await start;
  assert.deepEqual(h.native.pcmCapture, { endpointing: false, phone: false });
  const [cloud] = h.clouds;
  assert.equal(cloud.continuous(), true, 'pauses commit segments while continuous');
  // Push-to-talk joins instead of restarting the mic, and releasing it keeps the capture.
  await h.bridge.startGlassesCapture(h.session, h.cloud, () => {});
  await h.bridge.stopPushToTalk();
  assert.equal(h.clouds.length, 1); assert.deepEqual(h.commands, [true]); assert.equal(h.native.finished, undefined);
  cloud.options.onTranscript({ text: 'First thought.', isFinal: true, paragraphBreakAfter: true });
  const stopped = h.bridge.stopContinuousCapture();
  assert.deepEqual(h.commands, [true, false]); assert.equal(h.native.finished, true);
  h.event({ kind: 'ended', message: 'Transcription stopped.' });
  assert.equal(cloud.finished, 1);
  // An earlier pause segment answering late must not end the drain.
  cloud.options.onTranscript({ text: 'Second thought.', isFinal: true, paragraphBreakAfter: true });
  assert.equal(cloud.stopped, false);
  cloud.options.onTranscript({ text: 'The tail.', isFinal: true, paragraphBreakAfter: false });
  await stopped;
  assert.equal(cloud.stopped, true);
  assert.deepEqual(h.text.map(event => event.text), ['First thought.', 'Second thought.', 'The tail.']);
  assert.equal(cloud.continuous(), false);
  assert.ok(ends >= 1);
});

test('push-to-talk after Transcribe closed starts its own capture instead of joining the finalizing one', async () => {
  const h = harness();
  const start = h.bridge.startGlassesCapture(h.session, h.cloud, () => {}, false, true); h.release(); await start;
  void h.bridge.stopContinuousCapture();
  h.event({ kind: 'ended', message: 'Transcription stopped.' });
  assert.equal(h.clouds[0].finished, 1, 'the closed window is still finalizing');
  const ptt = h.bridge.startGlassesCapture(h.session, h.cloud, () => {}); h.release(); await ptt;
  assert.equal(h.clouds.length, 2, 'push-to-talk got a capture of its own');
  assert.equal(h.clouds[0].stopped, true);
  assert.equal(h.clouds[1].continuous(), false);
});

test('continuous captures record to the requested WAV, created by their first audio and kept across restarts', async () => {
  const h = harness();
  h.bridge.recordTo('transcribe-2026-10-17-120000');
  // A start that fails before any audio leaves no file behind.
  h.native.error = 'No phone microphone is available.';
  await h.bridge.startPhoneCapture(h.cloud, () => {}, false, true);
  delete h.native.error;
  const start = h.bridge.startGlassesCapture(h.session, h.cloud, () => {}, false, true); h.release(); await start;
  assert.equal(h.recordings.length, 0);
  h.native.pcmHandler(new Uint8Array([1, 2, 3, 4]));
  h.native.pcmHandler(new Uint8Array([5, 6]));
  assert.equal(h.recordings.length, 1);
  assert.equal(h.recordings[0].name, 'transcribe-2026-10-17-120000');
  assert.deepEqual(h.recordings[0].pcm, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(h.clouds.at(-1).pcm, [[1, 2, 3, 4], [5, 6]], 'transcription still gets the audio');
  // A restarted capture (after a disconnect, say) keeps appending to the same file.
  h.bridge.stop();
  assert.equal(h.recordings[0].closed, false);
  const again = h.bridge.startGlassesCapture(h.session, h.cloud, () => {}, false, true); h.release(); await again;
  h.native.pcmHandler(new Uint8Array([7]));
  assert.equal(h.recordings.length, 1);
  assert.deepEqual(h.recordings[0].pcm, [1, 2, 3, 4, 5, 6, 7]);
  // Push-to-talk on a capture of its own is not recorded.
  h.bridge.stop();
  const ptt = h.bridge.startGlassesCapture(h.session, h.cloud, () => {}); h.release(); await ptt;
  h.native.pcmHandler(new Uint8Array([8]));
  assert.deepEqual(h.recordings[0].pcm, [1, 2, 3, 4, 5, 6, 7]);
  h.bridge.recordTo('');
  assert.equal(h.recordings[0].closed, true);
});

test('a glasses session ending drains continuous capture instead of discarding what it heard', async () => {
  const h = harness(); let ends = 0; h.bridge.onSpeechEnd(() => ends++);
  const start = h.bridge.startGlassesCapture(h.session, h.cloud, () => {}, false, true); h.release(); await start;
  const [cloud] = h.clouds;
  assert.equal(h.bridge.continuousSource, 'glasses');
  h.bridge.handleSessionEnded();
  assert.deepEqual(h.commands, [true, false]); assert.equal(h.native.finished, true);
  assert.equal(cloud.stopped, false, 'the open segment is still transcribed');
  assert.equal(h.bridge.continuousSource, null); assert.equal(h.bridge.continuousActive, true);
  // The controller reports the session state again while it reconnects.
  h.bridge.handleSessionEnded();
  h.event({ kind: 'ended', message: 'Ready to send' });
  assert.equal(cloud.finished, 1);
  assert.equal(ends, 0);
  cloud.options.onTranscript({ text: 'Last words.', isFinal: true });
  assert.equal(cloud.stopped, true); assert.equal(h.bridge.continuousActive, false);
  assert.equal(h.text.at(-1).text, 'Last words.');
  assert.match(h.bridge.statusText, /resumes when they reconnect/);
  assert.equal(ends, 1, 'the end lets the controller restart the capture');
});

test('backgrounding drains a continuous phone capture', async () => {
  const h = harness();
  await h.bridge.startPhoneCapture(h.cloud, () => {}, false, true);
  assert.equal(h.bridge.continuousSource, 'phone');
  h.bridge.stopPhoneCapture();
  assert.equal(h.native.finished, true); assert.equal(h.clouds[0].stopped, false);
  h.event({ kind: 'ended', message: 'Ready to send' });
  h.clouds[0].options.onTranscript({ text: 'Tail.', isFinal: true });
  assert.equal(h.bridge.continuousActive, false);
  assert.equal(h.text.at(-1).text, 'Tail.');
  assert.match(h.bridge.statusText, /background/);
});
