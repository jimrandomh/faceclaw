const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

/** FaceclawSpeechAnalyzer.swift's surface; `emit` plays its JSON events. */
class FakeAnalyzer {
  static supported = true;
  static instances = [];
  static new() { const native = new FakeAnalyzer(); FakeAnalyzer.instances.push(native); return native; }
  static isSupported() { return FakeAnalyzer.supported; }
  constructor() { this.pcm = []; this.finished = 0; this.cancelled = 0; this.language = null; }
  startWithLanguage(language) { this.language = language; }
  acceptPcm(data) { this.pcm.push([...data]); }
  finish() { this.finished++; }
  cancel() { this.cancelled++; }
  emit(event) { this.eventHandler(JSON.stringify(event)); }
}

function load() {
  FakeAnalyzer.instances = [];
  FakeAnalyzer.supported = true;
  const timers = new Set();
  const modules = loader({
    FaceclawSpeechAnalyzer: FakeAnalyzer,
    NSData: { dataWithBytesLength: (buffer, length) => new Uint8Array(buffer, 0, length) },
    interop: { handleof: buffer => buffer },
    setTimeout(fn) { timers.add(fn); return fn; },
    clearTimeout(fn) { timers.delete(fn); },
  }, {});
  return { ...modules('app/native/speech-analyzer-stt.ios.ts'), timers };
}

function client(language = '') {
  const { SpeechAnalyzerSttClient } = load();
  const events = [], statuses = [], errors = [];
  let ready = 0;
  const c = new SpeechAnalyzerSttClient({
    apiKey: '', language, onTranscript: event => events.push({ ...event }), onStatus: status => statuses.push(status),
    onError: error => errors.push(error), onReady: () => ready++,
  });
  c.start();
  const native = FakeAnalyzer.instances[0];
  return { c, native, events, statuses, errors, ready: () => ready };
}

/** `seconds` of 16 kHz PCM16LE silence. */
const pcm = seconds => new Uint8Array(Math.round(seconds * 16000) * 2);
/** A result as FaceclawSpeechAnalyzer.swift reports it: its audio range and when its last word ends. */
const result = (text, final, start, end, speechEnd = end) => ({ kind: 'transcript', text, final, start, end, speechEnd });
const finals = h => h.events.filter(event => event.isFinal);

test('starts in the requested language and reports readiness as a provider would', () => {
  const h = client('es');
  assert.equal(h.native.language, 'es');
  h.native.emit({ kind: 'status', message: 'Downloading on-device speech model… 40%' });
  h.native.emit({ kind: 'ready', locale: 'es_ES' });
  assert.deepEqual(h.statuses, ['Downloading on-device speech model… 40%', 'Listening (on-device)...']);
  assert.equal(h.ready(), 1);
});

// Recorded from SpeechAnalyzer on macOS 26.4 (scripted speech, 1.5 s quiet, a
// pause, more speech): volatile ranges start where the last final ended, and
// the second final's first word reaches back into the silence (5.04 s; the
// speech starts at 6.18 s).
test('real model output: the first paragraph ends as soon as its last words are final', () => {
  const h = client();
  h.native.emit({ kind: 'ready', locale: 'en_US' });
  h.native.emit(result('Hello there.', false, 0, 4.1));
  h.native.emit(result('Hello there.', true, 0, 0.66, 0.6));
  h.native.emit(result(' This is the firstst paragraph of the test spoken ', false, 0.66, 4.1815));
  h.c.acceptPcm(pcm(5.6815));
  h.c.commitSegment();
  assert.equal(finals(h).length, 0, 'words before the pause are still provisional');
  h.native.emit(result(' This is the firstst paragraph of the test spoken before a pause.', false, 0.66, 7.7815));
  h.native.emit(result(' This is the first paragraph of the test, spoken before a pause.', true, 0.66, 4.38, 4.32));
  assert.deepEqual(finals(h), [{ text: 'Hello there. This is the first paragraph of the test, spoken before a pause.', isFinal: true, paragraphBreakAfter: true }]);
  h.native.emit(result(' And this is a second', false, 4.38, 8.1815));
  assert.deepEqual(h.events.at(-1), { text: 'And this is a second', isFinal: false }, 'new speech shows in the new paragraph');
  h.native.emit(result(' And this is a second paragraph, which comes after the pause.', true, 5.04, 9.18, 9.12));
  h.c.finish();
  assert.equal(h.native.finished, 1);
  h.native.emit({ kind: 'finished' });
  assert.deepEqual(h.events.at(-1), { text: 'And this is a second paragraph, which comes after the pause.', isFinal: true });
  assert.equal(finals(h).length, 2);
  assert.equal(h.native.cancelled, 1, 'the finished session is released');
  h.native.emit(result('late', false, 9.2, 9.5));
  assert.equal(h.events.at(-1).text, 'And this is a second paragraph, which comes after the pause.', 'events after stop are ignored');
});

test('a pause after words already final ends the paragraph at once, keeping later provisional text', () => {
  const h = client();
  h.native.emit({ kind: 'ready', locale: 'en_US' });
  h.native.emit(result('Hello there.', true, 0, 1.0));
  h.native.emit(result('How are you?', true, 1.0, 1.8));
  h.c.acceptPcm(pcm(3.4));
  h.native.emit(result('Fine', false, 1.8, 3.4));
  h.c.commitSegment();
  assert.deepEqual(h.events.slice(-2), [
    { text: 'Hello there. How are you?', isFinal: true, paragraphBreakAfter: true },
    { text: 'Fine', isFinal: false },
  ]);
});

test('a final ending mid-sentence before the pause waits for the rest of the sentence', () => {
  const h = client();
  h.native.emit({ kind: 'ready', locale: 'en_US' });
  h.c.acceptPcm(pcm(5.7));
  h.c.commitSegment();
  h.native.emit(result('This is the first paragraph, spoken', true, 0.5, 3.6));
  assert.equal(finals(h).length, 0);
  h.native.emit(result('before a pause.', true, 3.6, 4.3));
  assert.deepEqual(finals(h), [{ text: 'This is the first paragraph, spoken before a pause.', isFinal: true, paragraphBreakAfter: true }]);
});

test('without a final near the pause, a final ending after it starts the next paragraph', () => {
  const h = client();
  h.native.emit({ kind: 'ready', locale: 'en_US' });
  h.native.emit(result('Before.', true, 0, 2.0));
  // Background noise kept the pause detector from firing until well after the words.
  h.c.acceptPcm(pcm(8));
  h.c.commitSegment();
  assert.equal(finals(h).length, 0);
  h.native.emit(result('After.', true, 2.0, 9.5));
  assert.deepEqual(finals(h), [{ text: 'Before.', isFinal: true, paragraphBreakAfter: true }]);
  assert.deepEqual(h.events.at(-1), { text: 'After.', isFinal: false });
});

test('a pause with nothing before it adds no break', () => {
  const h = client();
  h.native.emit({ kind: 'ready', locale: 'en_US' });
  h.c.acceptPcm(pcm(3));
  h.c.commitSegment();
  h.native.emit(result('First words.', true, 0, 4.2));
  h.native.emit(result('More.', true, 4.2, 5.0));
  assert.equal(finals(h).length, 0);
  assert.deepEqual(h.events.at(-1), { text: 'First words. More.', isFinal: false });
});

test('errors end the session and reach the provider\'s error path', () => {
  const h = client();
  h.native.emit({ kind: 'error', message: "On-device transcription doesn't support xx." });
  assert.deepEqual(h.errors, ["On-device transcription doesn't support xx."]);
  assert.equal(h.native.cancelled, 1);
});

test('the wrapped client holds audio until the model is ready, then streams it', () => {
  const { createSpeechAnalyzerClient, speechAnalyzerSupported } = load();
  assert.equal(speechAnalyzerSupported(), true);
  FakeAnalyzer.supported = false;
  assert.equal(speechAnalyzerSupported(), false);
  const events = [];
  const wrapped = createSpeechAnalyzerClient({ onTranscript: event => events.push({ ...event }), onStatus() {}, onError() {} }, () => true);
  wrapped.start();
  const native = FakeAnalyzer.instances[0];
  wrapped.acceptPcm(new Uint8Array([1, 0, 2, 0]));
  assert.equal(native.pcm.length, 0, 'buffered while the model loads');
  native.emit({ kind: 'ready', locale: 'en_US' });
  wrapped.acceptPcm(new Uint8Array([3, 0]));
  assert.deepEqual(native.pcm, [[1, 0, 2, 0], [3, 0]]);
  wrapped.stop();
  assert.equal(native.cancelled, 1);
});
