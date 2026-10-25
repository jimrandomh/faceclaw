const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function load() {
  const timers = [];
  const modules = loader({
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimeout() {},
    DataView, Math, Date, JSON, Object, String, Error, Promise,
  }, {});
  return { ...modules('app/native/whisper-server-stt.ts'), timers };
}

/** An http stub whose requests resolve only when the test says so. */
function server(models = '{"data":[{"id":"openai/whisper-large-v3"}]}') {
  const requests = [];
  const http = (request) => new Promise((resolve, reject) => {
    if (request.method === 'GET') { requests.push({ ...request, kind: 'models' }); resolve({ status: 200, text: models }); return; }
    requests.push({ ...request, kind: 'transcribe', resolve, reject, fields: fields(request.body) });
  });
  return { http, requests, posts: () => requests.filter(request => request.kind === 'transcribe') };
}

function fields(body) {
  const text = Buffer.from(body).toString('latin1');
  const out = {};
  for (const match of text.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) out[match[1]] = match[2];
  return out;
}

function client(config = {}, s = server()) {
  const { WhisperServerSttClient, timers } = load();
  const events = [], statuses = [], errors = [];
  let ready = 0;
  const c = new WhisperServerSttClient({
    apiKey: config.apiKey ?? '', onTranscript: event => events.push({ ...event }), onStatus: status => statuses.push(status),
    onError: error => errors.push(error), onReady: () => ready++, onDisconnected: message => errors.push(`disconnected: ${message}`),
  }, { baseUrl: 'http://whisper-host:8004/v1', model: '', language: '', ...config }, s.http);
  return { c, s, events, statuses, errors, timers, ready: () => ready };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function speech(ms, amplitude = 3000) {
  const bytes = new Uint8Array(ms * 32);
  for (let i = 0; i < bytes.length; i += 2) {
    const sample = i % 4 ? amplitude : -amplitude;
    bytes[i] = sample & 255; bytes[i + 1] = (sample >> 8) & 255;
  }
  return bytes;
}

test('URL normalization accepts a bare host, a /v1 root and the full endpoint', () => {
  const { normalizeWhisperServerUrl } = load();
  assert.equal(normalizeWhisperServerUrl('http://192.0.2.10:8004'), 'http://192.0.2.10:8004/v1');
  assert.equal(normalizeWhisperServerUrl(' http://192.0.2.10:8004/v1/ '), 'http://192.0.2.10:8004/v1');
  assert.equal(normalizeWhisperServerUrl('https://stt.example/v1/audio/transcriptions'), 'https://stt.example/v1');
  assert.equal(normalizeWhisperServerUrl('192.0.2.10:8004'), '');
  assert.equal(normalizeWhisperServerUrl(''), '');
});

test('the WAV header describes 16 kHz mono PCM16 and the multipart body carries the fields', () => {
  const { wavFile, multipartBody } = load();
  const wav = wavFile([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])], 6);
  const view = Buffer.from(wav);
  assert.equal(view.toString('ascii', 0, 4), 'RIFF');
  assert.equal(view.readUInt32LE(24), 16000);
  assert.equal(view.readUInt16LE(22), 1);
  assert.equal(view.readUInt32LE(40), 6);
  assert.deepEqual([...wav.subarray(44)], [1, 2, 3, 4, 5, 6]);
  const body = Buffer.from(multipartBody('B', { model: 'm', language: 'sk' }, wav)).toString('latin1');
  assert.match(body, /^--B\r\nContent-Disposition: form-data; name="model"\r\n\r\nm\r\n/);
  assert.match(body, /name="file"; filename="audio.wav"\r\nContent-Type: audio\/wav\r\n\r\nRIFF/);
  assert.ok(body.endsWith('\r\n--B--\r\n'));
});

test('start lists models, picks the first id, and push-to-talk delivers one final', async () => {
  const h = client();
  h.c.start(); await flush();
  assert.equal(h.ready(), 1);
  assert.equal(h.s.requests[0].url, 'http://whisper-host:8004/v1/models');
  h.c.acceptPcm(speech(500));
  h.c.finish();
  const [post] = h.s.posts();
  assert.equal(post.url, 'http://whisper-host:8004/v1/audio/transcriptions');
  assert.equal(post.fields.model, 'openai/whisper-large-v3');
  assert.equal(post.fields.response_format, 'json');
  assert.equal('language' in post.fields, false, 'empty language lets Whisper auto-detect');
  assert.equal(post.headers.Authorization, undefined);
  post.resolve({ status: 200, text: '{"text":" Remind me to call the bank."}' }); await flush();
  assert.deepEqual(h.events, [{ text: 'Remind me to call the bank.', isFinal: true, paragraphBreakAfter: false }]);
});

test('a configured model, language and key are sent as given', async () => {
  const h = client({ model: 'whisper-1', language: 'SK', apiKey: 'secret' });
  h.c.start(); await flush();
  h.c.acceptPcm(speech(300)); h.c.finish();
  const [post] = h.s.posts();
  assert.equal(post.fields.model, 'whisper-1');
  assert.equal(post.fields.language, 'sk');
  assert.equal(post.headers.Authorization, 'Bearer secret');
});

test('silence is not sent (Whisper would invent text) but push-to-talk still gets an empty final', async () => {
  const h = client();
  h.c.start(); await flush();
  h.c.acceptPcm(speech(2000, 40));
  h.c.finish();
  assert.equal(h.s.posts().length, 0);
  assert.deepEqual(h.events, [{ text: '', isFinal: true, paragraphBreakAfter: false }]);
});

test('interim requests show provisional text and never overwrite the final', async () => {
  const h = client();
  h.c.start(); await flush();
  h.c.acceptPcm(speech(1600));
  const [interim] = h.s.posts();
  assert.ok(interim, 'an interim request goes out once enough audio arrived');
  h.c.acceptPcm(speech(1600));
  assert.equal(h.s.posts().length, 1, 'one interim in flight at a time');
  interim.resolve({ status: 200, text: '{"text":"hello"}' }); await flush();
  assert.deepEqual(h.events.at(-1), { text: 'hello', transcribeText: 'hello', isFinal: false });
  h.c.finish();
  const final = h.s.posts().at(-1);
  final.resolve({ status: 200, text: '{"text":"hello world"}' }); await flush();
  assert.deepEqual(h.events.at(-1), { text: 'hello world', isFinal: true, paragraphBreakAfter: false });
});

test('continuous segments finalize in audio order even when answered out of order', async () => {
  const h = client();
  h.c.start(); await flush();
  h.c.acceptPcm(speech(500)); h.c.commitSegment();
  h.c.acceptPcm(speech(500)); h.c.commitSegment();
  const [first, second] = h.s.posts();
  second.resolve({ status: 200, text: '{"text":"second"}' }); await flush();
  assert.deepEqual(h.events.map(event => event.isFinal), [false]);
  assert.equal(h.events[0].text, 'second');
  first.resolve({ status: 200, text: '{"text":"first"}' }); await flush();
  assert.deepEqual(h.events.filter(event => event.isFinal).map(event => [event.text, event.paragraphBreakAfter]),
    [['first', true], ['second', true]]);
});

/** Seconds of audio in a transcription request's WAV part. */
function postSeconds(post) {
  const body = Buffer.from(post.body);
  return body.readUInt32LE(body.indexOf('RIFF') + 40) / 32000;
}

test('nonstop speech is cut at its quietest moment into bounded requests that still leave as one final', async () => {
  const h = client();
  h.c.start(); await flush();
  // 25 s of 50 ms chunks with no pause; chunk 440 (22 s in) is the quietest.
  for (let i = 0; i < 500; i++) h.c.acceptPcm(speech(50, i === 440 ? 400 : 3000));
  const [, head, tailInterim] = h.s.posts();
  assert.equal(postSeconds(head), 22.05, 'the cut follows the quietest chunk');
  assert.equal(postSeconds(tailInterim), 2.95, 'the audio after it carries over');
  h.c.acceptPcm(speech(1000)); h.c.finish();
  const tail = h.s.posts().at(-1);
  assert.equal(postSeconds(tail), 3.95);
  tail.resolve({ status: 200, text: '{"text":"and the rest."}' }); await flush();
  assert.deepEqual(h.events.filter(event => event.isFinal), [], 'the tail waits for the head');
  head.resolve({ status: 200, text: '{"text":"The long part"}' }); await flush();
  assert.deepEqual(h.events.filter(event => event.isFinal),
    [{ text: 'The long part and the rest.', isFinal: true, paragraphBreakAfter: false }]);
});

test('a cut with nothing after it yet ends at the next boundary', async () => {
  const h = client();
  h.c.start(); await flush();
  for (let i = 0; i < 500; i++) h.c.acceptPcm(speech(50, i === 499 ? 400 : 3000));
  const head = h.s.posts().at(-1);
  assert.equal(postSeconds(head), 25);
  head.resolve({ status: 200, text: '{"text":"All of it."}' }); await flush();
  assert.deepEqual(h.events.filter(event => event.isFinal), []);
  h.c.commitSegment();
  assert.deepEqual(h.events.filter(event => event.isFinal), [{ text: 'All of it.', isFinal: true, paragraphBreakAfter: true }]);
});

test('a failed final is retried once, then reported without ending the capture', async () => {
  const h = client();
  h.c.start(); await flush();
  h.c.acceptPcm(speech(500)); h.c.commitSegment();
  h.s.posts()[0].reject(new Error('timed out')); await flush();
  assert.equal(h.timers.at(-1).delay, 750);
  h.timers.at(-1).fn();
  h.s.posts()[1].resolve({ status: 502, text: 'bad gateway' }); await flush();
  assert.match(h.statuses.at(-1), /Whisper server request failed: HTTP 502/);
  assert.deepEqual(h.errors, []);
  h.c.acceptPcm(speech(500)); h.c.finish();
  h.s.posts()[2].resolve({ status: 200, text: '{"text":"still here"}' }); await flush();
  assert.equal(h.events.at(-1).text, 'still here');
});

test('an auth rejection is an error, an unreachable server is a disconnect', async () => {
  const auth = client();
  auth.c.start(); await flush();
  auth.c.acceptPcm(speech(500)); auth.c.finish();
  auth.s.posts()[0].resolve({ status: 401, text: '' }); await flush();
  assert.deepEqual(auth.errors, ['Whisper server rejected the key (401).']);
  const down = client({}, { http: () => Promise.reject(new Error('connection refused')) });
  down.c.start(); await flush();
  assert.equal(down.ready(), 0);
  assert.deepEqual(down.errors, ['disconnected: Whisper server unreachable: connection refused']);
});

test('provider selection needs a URL, not a key, and passes the server settings through', () => {
  const sockets = [];
  const modules = loader({
    setTimeout() {}, clearTimeout() {}, console: { log() {}, warn() {} }, DataView,
    com: { faceclaw: { app: {
      FaceclawWebSocketListener: function(callbacks) { return callbacks; },
      FaceclawWebSocket: class { constructor(url) { sockets.push(url); } },
    } } },
  }, { './cloud-stt': { CLOUD_STT_SAMPLE_RATE: 16000, encodeBase64: () => '', toJavaBytes: bytes => bytes } });
  const { createCloudSttClient, usesCloudStt } = modules('app/native/cloud-stt-provider.ts');
  const statuses = [];
  const options = { onTranscript() {}, onStatus: status => statuses.push(status), onError() {} };
  const selection = { provider: 'whisper-server', elevenLabsApiKey: '', openAiApiKey: '', sonioxApiKey: '' };
  assert.equal(usesCloudStt(selection), false);
  assert.equal(createCloudSttClient(selection, options, () => false), null);
  assert.deepEqual(statuses, ['No Whisper server URL set; using on-device voice.']);
  const configured = { ...selection, whisperServerUrl: 'http://192.0.2.10:8004' };
  assert.equal(usesCloudStt(configured), true);
  const client = createCloudSttClient(configured, options, () => false);
  assert.ok(client.finalTimeoutMs > 5000, 'batch requests get longer than the 5s realtime default');
  assert.equal(sockets.length, 0);
});
