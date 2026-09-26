const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function harness(provider = 'elevenlabs', continuous = true) {
  const timers = new Map();
  let timerId = 0;
  const sockets = [];
  const events = [], statuses = [], errors = [];
  const load = loader({
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    console: { log() {}, warn() {} },
    com: { faceclaw: { app: {
      FaceclawWebSocketListener: function(callbacks) { return callbacks; },
      FaceclawWebSocket: class {
        constructor(url, listener) { Object.assign(this, { url, listener, sent: [], closed: false, reject: false }); sockets.push(this); }
        sendText(text) { if (this.reject) return false; this.sent.push(text); return true; }
        sendBinary(bytes) { if (this.reject) return false; this.sent.push(bytes); return true; }
        close() { this.closed = true; }
      }, } }, },
  }, {
    './cloud-stt': {
      CLOUD_STT_SAMPLE_RATE: 16000,
      encodeBase64: bytes => Buffer.from(bytes).toString('base64'),
      toJavaBytes: bytes => bytes,
    },
  });
  const names = { elevenlabs: 'ElevenLabsSttClient', openai: 'OpenAiRealtimeSttClient', soniox: 'SonioxSttClient' };
  const Provider = load(`app/native/${provider}-stt.ts`)[names[provider]];
  const { ReconnectingSttClient } = load('app/native/reconnecting-stt.ts');
  const client = new ReconnectingSttClient(options => new Provider(options), {
    apiKey: 'test', onTranscript: event => events.push(event),
    onStatus: status => statuses.push(status), onError: error => errors.push(error),
  }, () => continuous);
  client.start();
  return { client, sockets, events, statuses, errors, timers,
    open() { sockets.at(-1).listener.onOpen(); },
    message(message, socket = sockets.at(-1)) { socket.listener.onTextMessage(JSON.stringify(message)); },
    tick() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); return timer.delay; },
  };
}

function pcm(amplitude, ms = 50) {
  const bytes = new Uint8Array(ms * 32);
  for (let i = 0; i < bytes.length; i += 2) { bytes[i] = amplitude & 255; bytes[i + 1] = amplitude >> 8; }
  return bytes;
}

for (const provider of ['elevenlabs', 'openai', 'soniox']) {
  test(`${provider}: failure and close reconnect, stale callbacks are ignored, stop cancels retry`, () => {
    const h = harness(provider);
    h.open();
    const old = h.sockets[0];
    old.listener.onFailure('network unavailable');
    old.listener.onClosed(); // Both callbacks must schedule only one retry.
    assert.equal(h.timers.size, 1);
    assert.equal(old.closed, true);
    h.client.acceptPcm(pcm(2000));
    assert.equal(h.tick(), 1000);
    assert.equal(h.sockets.length, 2);
    h.open();
    assert.ok(h.sockets[1].sent.length > 0);
    const eventCount = h.events.length;
    old.listener.onTextMessage(JSON.stringify({ message_type: 'partial_transcript', text: 'stale' }));
    old.listener.onOpen();
    assert.equal(h.events.length, eventCount);
    h.sockets[1].listener.onClosed();
    assert.equal(h.timers.size, 1);
    h.client.stop();
    assert.equal(h.timers.size, 0);
  });

  test(`${provider}: rejected audio send triggers recovery and requeues the packet`, () => {
    const h = harness(provider);
    h.open();
    h.sockets[0].reject = true;
    h.client.acceptPcm(pcm(2000));
    assert.equal(h.timers.size, 1);
    h.tick(); h.open();
    assert.ok(h.sockets[1].sent.length > (provider === 'elevenlabs' ? 0 : 1));
    h.client.stop();
  });

  test(`${provider}: auth failure stops instead of retrying indefinitely`, () => {
    const h = harness(provider);
    h.sockets[0].listener.onFailure("Expected HTTP 101 response but was '401 Unauthorized'");
    assert.equal(h.timers.size, 0);
    assert.equal(h.errors.length, 1);
  });
}

test('reconnect preserves visible partials once and does not replay already-sent audio', () => {
  const h = harness(); h.open();
  h.client.acceptPcm(pcm(2000));
  h.message({ message_type: 'partial_transcript', text: 'Before outage' });
  h.sockets[0].listener.onFailure('offline');
  assert.equal(h.events.at(-1).text, 'Before outage');
  assert.equal(h.events.at(-1).isFinal, true);
  h.tick(); h.open();
  assert.equal(h.sockets[1].sent.length, 0);
  h.message({ message_type: 'partial_transcript', text: 'After outage' });
  assert.equal(h.events.at(-1).text, 'After outage');
  h.client.stop();
});

test('pending audio is bounded to ten seconds and backoff is capped', () => {
  const h = harness();
  for (let i = 0; i < 20; i++) h.client.acceptPcm(pcm(i, 1000));
  h.open();
  const sentBytes = h.sockets[0].sent.reduce((sum, text) => sum + Buffer.from(JSON.parse(text).audio_base_64, 'base64').length, 0);
  assert.equal(sentBytes, 320000);
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    h.sockets.at(-1).listener.onFailure('offline');
    assert.equal(h.tick(), delay);
  }
  h.client.stop();
});

test('finishing while disconnected cancels retries; finishing on an open socket times out cleanly', () => {
  const h = harness(); h.open();
  h.sockets[0].listener.onClosed();
  h.client.finish();
  assert.equal(h.timers.size, 0);
  const live = harness(); live.open();
  live.client.finish();
  assert.equal(live.tick(), 5000);
  assert.equal(live.sockets[0].closed, true);
  live.sockets[0].listener.onFailure('late');
  assert.equal(live.timers.size, 0);
});

test('only continuous capture commits at pauses, keeping ElevenLabs connected', () => {
  for (const continuous of [false, true]) {
    const h = harness('elevenlabs', continuous); h.open();
    h.client.acceptPcm(pcm(3000));
    h.client.acceptPcm(pcm(0, 1500));
    const commits = h.sockets[0].sent.map(JSON.parse).filter(m => m.commit);
    assert.equal(commits.length, continuous ? 1 : 0);
    if (continuous) {
      h.message({ message_type: 'committed_transcript', text: 'First.' });
      h.message({ message_type: 'committed_transcript_with_timestamps', text: 'First.' });
      assert.equal(h.events.length, 1);
      assert.equal(h.events[0].paragraphBreakAfter, true);
      assert.equal(h.sockets[0].closed, false);
    }
    h.client.stop();
  }
});

test('OpenAI keeps successive items separate and drains out-of-order completions in audio order', () => {
  const h = harness('openai'); h.open();
  h.client.acceptPcm(pcm(3000)); h.client.acceptPcm(pcm(0, 1500));
  h.message({ type: 'input_audio_buffer.committed', item_id: 'a' });
  h.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'Fir' });
  h.client.acceptPcm(pcm(3000)); h.client.acceptPcm(pcm(0, 1500));
  h.message({ type: 'input_audio_buffer.committed', item_id: 'b' });
  h.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', transcript: 'Second.' });
  assert.equal(h.events.some(e => e.isFinal), false);
  h.message({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'First.' });
  assert.deepEqual(h.events.filter(e => e.isFinal).map(e => e.text), ['First.', 'Second.']);
  assert.equal(h.sockets[0].closed, false);
  h.message({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'c', delta: 'Third.' });
  assert.equal(h.events.at(-1).text, 'Third.');
  h.client.stop();
});

test('Soniox speaker and pause formatting remains separate from dictation text and resets on finalize', () => {
  const h = harness('soniox'); h.open();
  h.message({ tokens: [
    { text: 'Hello.', start_ms: 0, end_ms: 500, speaker: '1', is_final: true },
    { text: ' Hi.', start_ms: 550, end_ms: 800, speaker: '2', is_final: false },
  ] });
  assert.equal(h.events.at(-1).text, 'Hello. Hi.');
  assert.equal(h.events.at(-1).transcribeText, 'Hello.\nHi.');
  h.message({ tokens: [
    { text: ' Yes.', start_ms: 550, end_ms: 800, speaker: '2', is_final: true },
    { text: '<fin>', is_final: true },
  ] });
  assert.equal(h.events.find(e => e.isFinal).transcribeText, 'Hello.\nYes.');
  h.message({ tokens: [{ text: 'New.', start_ms: 3000, end_ms: 3400, speaker: '2', is_final: false }] });
  assert.equal(h.events.at(-1).text, 'New.');
  h.client.stop();
});

test('an unsolicited Soniox session end finalizes visible text and reconnects', () => {
  const h = harness('soniox'); h.open();
  h.message({ tokens: [{ text: 'Before expiry.', is_final: true }], finished: true });
  assert.equal(h.events.at(-1).isFinal, true);
  assert.equal(h.events.at(-1).text, 'Before expiry.');
  assert.equal(h.timers.size, 1);
  h.tick(); h.open();
  assert.equal(h.sockets.length, 2);
  h.client.stop();
});
