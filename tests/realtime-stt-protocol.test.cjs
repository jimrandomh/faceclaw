const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../.test-build/app/native/realtime-stt-protocol.js');

test('OpenAI session payload is unchanged (GA transcription session, no server VAD)', () => {
  assert.equal(protocol.OPENAI_REALTIME_URL, 'wss://api.openai.com/v1/realtime?intent=transcription');
  assert.equal(protocol.OPENAI_REALTIME_MODEL, 'gpt-realtime-whisper');
  assert.deepEqual(protocol.openAiSessionUpdate('gpt-realtime-whisper'), {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: 'gpt-realtime-whisper' },
          turn_detection: null,
        },
      },
    },
  });
});

test('self-hosted payload keeps server VAD inert and never asks for a response', () => {
  const update = protocol.compatSessionUpdate('Systran/faster-distil-whisper-small.en');
  assert.equal(update.type, 'session.update');
  assert.equal('input_audio_format' in update.session, false);
  assert.deepEqual(update.session.input_audio_transcription, { model: 'Systran/faster-distil-whisper-small.en' });
  assert.deepEqual(update.session.turn_detection, {
    type: 'server_vad',
    threshold: 1,
    silence_duration_ms: 60000,
    prefix_padding_ms: 0,
    create_response: false,
  });
  // Exactly the bytes probed against Speaches v0.8.3 and v0.9.0-rc.3.
  assert.equal(
    JSON.stringify(update),
    '{"type":"session.update","session":{"input_audio_transcription":{"model":"Systran/faster-distil-whisper-small.en"},'
      + '"turn_detection":{"type":"server_vad","threshold":1,"silence_duration_ms":60000,"prefix_padding_ms":0,"create_response":false}}}',
  );
});

test('server-VAD option uses Speaches defaults within its 3 s window', () => {
  const vad = protocol.compatSessionUpdate('m', { serverVad: true }).session.turn_detection;
  assert.equal(vad.threshold, 0.9);
  assert.equal(vad.silence_duration_ms, 550);
  assert.ok(vad.silence_duration_ms <= 2500);
  assert.equal(vad.create_response, false);
});

test('self-hosted URL builder', () => {
  const model = 'Systran/faster-distil-whisper-small.en';
  const suffix = '/v1/realtime?model=Systran%2Ffaster-distil-whisper-small.en&intent=transcription';
  const url = (host, port = '8000') => protocol.selfHostedRealtimeUrl({ host, port, model });
  assert.equal(url('100.101.102.103'), `ws://100.101.102.103:8000${suffix}`);
  assert.equal(url(' 100.101.102.103 ', ''), `ws://100.101.102.103:8000${suffix}`);
  assert.equal(url('wss://desk.tailnet.ts.net', ''), `wss://desk.tailnet.ts.net:443${suffix}`);
  assert.equal(url('https://desk.tailnet.ts.net/', '8443'), `wss://desk.tailnet.ts.net:8443${suffix}`);
  assert.equal(url('http://h/', '9000'), `ws://h:9000${suffix}`);
  assert.equal(url('WS://h'), `ws://h:8000${suffix}`);
  assert.equal(url('[fd7a::1]'), `ws://[fd7a::1]:8000${suffix}`);
  for (const port of ['0', '70000', 'abc', '80.5', '-1']) assert.equal(url('h', port), null, port);
  assert.equal(url(''), null);
  assert.equal(url('ws://'), null);
  assert.equal(protocol.selfHostedRealtimeUrl({ host: 'h', port: '8000', model: '  ' }), null);
});

test('error classifier, with the exact Speaches strings', () => {
  const classify = protocol.classifyRealtimeError;
  assert.equal(classify({
    type: 'invalid_request_error',
    message: 'Specifying `session.turn_detection.prefix_padding_ms` is not supported. The server either does not support this field or it is not configurable.',
  }), 'ignore');
  assert.equal(classify({
    type: 'invalid_request_error',
    message: 'Error committing input audio buffer: buffer too small. Expected at least 100ms of audio, but buffer only has 50.00ms of audio.',
  }), 'commit-rejected');
  assert.equal(classify({ type: 'invalid_request_error', code: 'input_audio_buffer_commit_empty', message: 'x' }), 'commit-rejected');
  assert.equal(classify({ type: 'server_error', message: 'InternalServerError: Internal Server Error' }), 'disconnect');
  assert.equal(classify({ type: 'invalid_request_error', code: 'rate_limit_exceeded', message: 'slow down' }), 'disconnect');
  assert.equal(classify({ type: 'invalid_request_error', message: "Model 'x' is not installed locally." }), 'fatal');
  assert.equal(classify({ type: 'invalid_request_error', message: 'Not Found' }), 'fatal');
  assert.equal(classify(undefined), 'fatal');
});
