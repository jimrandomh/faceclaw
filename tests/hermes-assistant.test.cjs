const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function hermes() {
  const requests = [];
  const load = loader({ setTimeout, clearTimeout, JSON, Object, String, Number, Error }, {
    './sse': { openSseRequest: (url, body, headers, listener) => {
      const request = { url, body: JSON.parse(body), headers, listener, cancelled: false, cancel() { this.cancelled = true; } };
      requests.push(request);
      return request;
    } },
  });
  return { ...load('app/native/hermes.ts'), requests };
}

function stream(api, extra = {}) {
  const deltas = [], results = [], errors = [];
  api.streamHermesChat({
    apiKey: 'k', model: 'hermes-agent', system: 'glasses', baseUrl: 'http://hermes-host:8642', sessionId: 'faceclaw-1',
    messages: [{ role: 'user', content: 'Remember kiwi.' }, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'Which word?' }],
    onTextDelta: (delta) => deltas.push(delta), onDone: (r) => results.push(r), onError: (e) => errors.push(e), ...extra,
  });
  return { deltas, results, errors, request: api.requests.at(-1) };
}

const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}`;

test('Hermes gets only the latest user message, the session header and the key', () => {
  const api = hermes();
  const { request } = stream(api);
  assert.equal(request.url, 'http://hermes-host:8642/v1/chat/completions');
  assert.equal(request.headers['X-Hermes-Session-Id'], 'faceclaw-1');
  assert.equal(request.headers.Authorization, 'Bearer k');
  assert.equal(request.body.stream, true);
  assert.deepEqual(request.body.messages.map((m) => [m.role, m.content]), [['system', 'glasses'], ['user', 'Which word?']]);
});

test('answer deltas stream, reasoning is not shown, [DONE] finishes the turn', () => {
  const api = hermes();
  const s = stream(api);
  s.request.listener.onLine(chunk({ role: 'assistant' }));
  s.request.listener.onLine(chunk({ reasoning_content: 'The word was kiwi.' }));
  s.request.listener.onLine(chunk({ content: '\n\n' }));
  s.request.listener.onLine(chunk({ content: 'Ki' }));
  s.request.listener.onLine(chunk({ content: 'wi' }, 'stop'));
  s.request.listener.onLine('data: [DONE]');
  assert.deepEqual(s.deltas, ['Ki', 'wi']);
  assert.deepEqual(s.results.map((r) => [r.text, r.stopReason]), [['Kiwi', 'end_turn']]);
  assert.deepEqual(s.errors, []);
});

test('a rejected key and an empty stream are errors', () => {
  const api = hermes();
  const rejected = stream(api);
  rejected.request.listener.onHttpError(401, '{}');
  assert.deepEqual(rejected.errors, ['Hermes: the API server rejected the key']);
  const empty = stream(api);
  empty.request.listener.onComplete();
  assert.deepEqual(empty.errors, ['Hermes stream ended without a reply']);
});

test('URL normalization adds /v1 to a bare host and drops the endpoint path', () => {
  const { normalizeHermesUrl } = hermes();
  assert.equal(normalizeHermesUrl('http://192.0.2.10:8642'), 'http://192.0.2.10:8642/v1');
  assert.equal(normalizeHermesUrl('http://h:8642/v1/chat/completions'), 'http://h:8642/v1');
  assert.equal(normalizeHermesUrl('h:8642'), '');
});

test('the Hermes model resolves only with a URL, carrying the key and base URL', () => {
  const load = loader({ global: { isIOS: true } }, { '../native/llama': { isLocalModelReady: () => false, LOCAL_MODEL: { id: 'q', label: 'Q' } } });
  const { resolveAssistantModel } = load('app/assistant/models.ts');
  assert.equal(resolveAssistantModel('hermes', { anthropic: '', openai: '' }), null);
  const resolved = resolveAssistantModel('hermes', { anthropic: '', openai: '', hermesUrl: ' http://hermes-host:8642 ', hermesKey: ' k ' });
  assert.deepEqual({ ...resolved }, { selection: 'hermes', provider: 'hermes', model: 'hermes-agent', apiKey: 'k', baseUrl: 'http://hermes-host:8642' });
  assert.equal(resolveAssistantModel('auto', { anthropic: '', openai: '', hermesUrl: 'http://hermes-host:8642' }), null, 'Auto never picks Hermes');
});
