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

test('failed, interrupted, empty and cut-off runs are errors, not blank answers', () => {
  const api = hermes();
  const ending = (lines, close = 'done') => {
    const s = stream(api);
    for (const line of lines) s.request.listener.onLine(line);
    if (close === 'done') s.request.listener.onLine('data: [DONE]');
    else s.request.listener.onComplete();
    assert.deepEqual(s.results, []);
    return s.errors;
  };
  // Hermes's finish chunk: an error object rides along only when there is a message to show.
  const finish = (reason, extra = {}) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }], ...extra })}`;
  assert.deepEqual(ending([chunk({ content: 'Half' }), finish('error')]), ['Hermes: the agent run failed']);
  assert.deepEqual(ending([finish('error', { error: { message: 'admission_conflict', type: 'agent_error' } })]), ['Hermes: admission_conflict']);
  assert.deepEqual(ending([chunk({ content: 'Half' }), finish('cancelled')]), ['Hermes: the agent run was interrupted']);
  assert.deepEqual(ending([finish('stop')]), ['Hermes ended the turn without a reply']);
  assert.deepEqual(ending([chunk({ content: 'Half' })], 'close'), ['Hermes: the reply was cut off']);
  const closed = stream(api);
  closed.request.listener.onLine(chunk({ content: 'Kiwi' }, 'stop'));
  closed.request.listener.onComplete();
  assert.deepEqual(closed.results.map((r) => r.text), ['Kiwi'], 'a finished stream may close without [DONE]');
});

test('a restored conversation keeps its Hermes session, and Hermes turns get a long deadline', () => {
  const requests = [], delays = [];
  const load = loader({ global: { isIOS: false, isAndroid: true }, setTimeout: (_fn, ms) => { delays.push(ms); return 0; }, clearTimeout: () => {} }, {
    './sse': { openSseRequest: (_url, _body, headers, listener) => {
      const request = { headers, listener, cancel() {} };
      requests.push(request);
      return request;
    } },
    '../native/llama': { streamLocalQwen: () => assert.fail('no local model') },
    './bridge-client': { assistantBridge: {} }, './tool-registry': { toolRegistry: {} },
    '../prompts': { ASSISTANT_SYSTEM_PROMPT_BASE: '', buildAssistantSystemPrompt: () => '', describeAssistantContext: () => '' },
  });
  const { AssistantSession } = load('app/assistant/session.ts');
  const config = { kind: 'direct', llm: { selection: 'hermes', provider: 'hermes', model: 'hermes-agent', apiKey: 'k', baseUrl: 'http://hermes-host:8642' } };
  const callbacks = { onTextDelta() {}, onToolActivity() {}, onError: (e) => assert.fail(e), onTurnDone() {} };
  const turn = (session, text) => {
    session.sendUtterance(text, {}, callbacks);
    const request = requests.at(-1);
    request.listener.onLine(chunk({ content: 'OK' }, 'stop'));
    request.listener.onLine('data: [DONE]');
    return request.headers['X-Hermes-Session-Id'];
  };
  const first = new AssistantSession(config, undefined);
  const id = turn(first, 'Remember kiwi.');
  assert.match(id, /^faceclaw-/);
  assert.ok(delays.includes(20 * 60 * 1000), 'Hermes turns are not held to the 2-minute LLM cap');
  const restored = new AssistantSession(config, undefined, JSON.parse(JSON.stringify(first.history())));
  assert.equal(turn(restored, 'Which word?'), id);
  assert.notEqual(turn(new AssistantSession(config, undefined), 'Hello'), id, 'a new conversation gets its own session');
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
