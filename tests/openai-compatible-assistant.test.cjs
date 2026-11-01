const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));

function assistant({ apiKey = 'fixture-key', baseUrl = 'https://provider.example/api/v1' } = {}) {
  const requests = [], calls = [], deltas = [], errors = [], done = [];
  const registry = {
    listTools: () => [
      { name: 'timer.set', description: 'Set a timer', inputSchema: { type: 'object', properties: { seconds: { type: 'number' } } } },
      { name: 'glasses.show_alert', description: 'Show an alert', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, content: `${name} completed` };
    },
  };
  const load = loader({ global: { isIOS: false, isAndroid: true }, setTimeout, clearTimeout }, {
    './sse': { openSseRequest: (url, body, headers, listener) => {
      const request = { url, body: JSON.parse(body), headers, listener, cancelled: false };
      requests.push(request);
      return { cancel: () => { request.cancelled = true; } };
    } },
    '../native/local-llm': { streamLocalModel: () => assert.fail('unexpected local model'), isLocalModelReady: () => false, isLocalModelSupported: () => true, LOCAL_MODEL: { id: 'qwen', label: 'Qwen' } },
    './bridge-client': { assistantBridge: {} },
    './tool-registry': { toolRegistry: registry },
    '../prompts': {
      ASSISTANT_SYSTEM_PROMPT_BASE: 'test',
      buildAssistantSystemPrompt: () => 'glasses system',
      describeAssistantContext: () => '',
    },
  });
  const { AssistantSession } = load('app/assistant/session.ts');
  const session = new AssistantSession({ kind: 'direct', llm: {
    selection: 'openai-compatible', provider: 'openai-compatible', model: 'fixture-model', apiKey, baseUrl,
  } }, registry);
  const send = text => session.sendUtterance(text, {}, {
    onTextDelta: (_delta, full) => deltas.push(full),
    onToolActivity() {},
    onError: error => errors.push(error),
    onTurnDone: result => done.push(result),
  });
  const event = (request, value) => request.listener.onLine('data: ' + JSON.stringify(value));
  const chunk = (request, delta, finishReason = null) => event(request, { choices: [{ index: 0, delta, finish_reason: finishReason }] });
  const finish = (request, reason = 'stop', close = 'done') => {
    chunk(request, {}, reason);
    if (close === 'done') request.listener.onLine('data: [DONE]');
    else request.listener.onComplete();
  };
  return { load, session, send, event, chunk, finish, requests, calls, deltas, errors, done };
}

test('compatible provider sends full history, nested tools, the exact API root and optional auth', () => {
  const h = assistant();
  h.send('Remember the blue door');
  const first = h.requests[0];
  assert.equal(first.url, 'https://provider.example/api/v1/chat/completions');
  assert.equal(first.headers.Authorization, 'Bearer fixture-key');
  assert.equal(first.headers['Content-Type'], 'application/json');
  assert.equal(first.body.model, 'fixture-model');
  assert.equal(first.body.stream, true);
  assert.equal('max_tokens' in first.body, false, 'provider default output limit is preserved');
  assert.equal('reasoning_effort' in first.body, false, 'custom models default to provider reasoning');
  assert.deepEqual(first.body.messages.map(m => [m.role, m.content]), [
    ['system', 'glasses system'], ['user', 'Remember the blue door'],
  ]);
  assert.equal(first.body.tools[0].type, 'function');
  assert.equal(first.body.tools[0].function.name, 'timer_set');
  assert.equal(first.body.tools[0].function.parameters.type, 'object');
  h.chunk(first, { content: 'Remembered.' }); h.finish(first);
  h.send('What color?');
  assert.deepEqual(h.requests[1].body.messages.slice(-3).map(m => [m.role, m.content]), [
    ['user', 'Remember the blue door'], ['assistant', 'Remembered.'], ['user', 'What color?'],
  ]);
  h.session.cancel();

  const noKey = assistant({ apiKey: '' });
  noKey.send('Private request');
  assert.equal('Authorization' in noKey.requests[0].headers, false);
  noKey.session.cancel();
});

test('Venice web search is opt-in and never leaks to other compatible providers', () => {
  const defaultOff = assistant({ baseUrl: 'https://api.venice.ai/api/v1' });
  defaultOff.send('Current weather');
  assert.equal('venice_parameters' in defaultOff.requests[0].body, false);
  defaultOff.session.cancel();

  const { isVeniceApiBaseUrl } = defaultOff.load('app/native/openai-chat.ts');
  assert.equal(isVeniceApiBaseUrl(' https://api.venice.ai/api/v1/ '), true);
  assert.equal(isVeniceApiBaseUrl('https://api.venice.ai/api/v1/chat/completions'), true);
  assert.equal(isVeniceApiBaseUrl('http://api.venice.ai/api/v1'), false);
  assert.equal(isVeniceApiBaseUrl('https://api.venice.ai.evil.example/api/v1'), false);
  assert.equal(isVeniceApiBaseUrl('https://openwebui.example/api'), false);

  const enabled = assistant({ baseUrl: 'https://api.venice.ai/api/v1' });
  enabled.session.configure({ kind: 'direct', llm: {
    selection: 'openai-compatible', provider: 'openai-compatible', model: 'fixture-model',
    apiKey: 'fixture-key', baseUrl: 'https://api.venice.ai/api/v1', webSearch: true,
  } });
  enabled.send('Current weather');
  assert.deepEqual(JSON.parse(JSON.stringify(enabled.requests[0].body.venice_parameters)), {
    enable_web_search: 'on',
  });
  enabled.session.cancel();

  const openWebUi = assistant({ baseUrl: 'https://openwebui.example/api' });
  openWebUi.session.configure({ kind: 'direct', llm: {
    selection: 'openai-compatible', provider: 'openai-compatible', model: 'fixture-model',
    apiKey: 'fixture-key', baseUrl: 'https://openwebui.example/api', webSearch: true,
  } });
  openWebUi.send('Current weather');
  assert.equal('venice_parameters' in openWebUi.requests[0].body, false);
  openWebUi.session.cancel();
});

test('Venice and Open WebUI roots are preserved; only a complete endpoint suffix is removed', () => {
  const { normalizeOpenAiCompatibleUrl } = assistant().load('app/native/openai-chat.ts');
  assert.equal(normalizeOpenAiCompatibleUrl(' https://api.venice.ai/api/v1/ '), 'https://api.venice.ai/api/v1');
  assert.equal(normalizeOpenAiCompatibleUrl('https://api.venice.ai/api/v1/chat/completions'), 'https://api.venice.ai/api/v1');
  assert.equal(normalizeOpenAiCompatibleUrl('http://100.64.0.1:3000/api'), 'http://100.64.0.1:3000/api');
  assert.equal(normalizeOpenAiCompatibleUrl('https://openwebui.example/api/chat/completions/'), 'https://openwebui.example/api');
  assert.equal(normalizeOpenAiCompatibleUrl('https://provider.example/custom/root'), 'https://provider.example/custom/root');
  assert.equal(normalizeOpenAiCompatibleUrl('provider.example/v1'), '');
  assert.equal(normalizeOpenAiCompatibleUrl('https://provider.example/v1?key=secret'), '');
  assert.equal(normalizeOpenAiCompatibleUrl('https://provider.example/v1#fragment'), '');
  assert.equal(normalizeOpenAiCompatibleUrl('https://user:secret@provider.example/v1'), '', 'credentials never belong in saved URLs');
});

test('compatible model resolves only with URL and model, and Auto remains unchanged', () => {
  const { ASSISTANT_MODEL_CHOICES, resolveAssistantModel } = assistant().load('app/assistant/models.ts');
  assert.equal(ASSISTANT_MODEL_CHOICES.includes('openai-compatible'), true);
  assert.equal(resolveAssistantModel('openai-compatible', { anthropic: '', openai: '' }), null);
  assert.equal(resolveAssistantModel('openai-compatible', {
    anthropic: '', openai: '', openAiCompatibleUrl: 'https://provider.example/api/v1', openAiCompatibleModel: '',
  }), null);
  const resolved = resolveAssistantModel('openai-compatible', {
    anthropic: '', openai: '',
    openAiCompatibleUrl: ' https://provider.example/api/v1 ',
    openAiCompatibleKey: ' secret ', openAiCompatibleModel: ' model-id ',
  });
  assert.equal(resolved.provider, 'openai-compatible');
  assert.equal(resolved.model, 'model-id');
  assert.equal(resolved.apiKey, 'secret');
  assert.equal(resolved.baseUrl, 'https://provider.example/api/v1');
  assert.equal(resolved.effort, undefined);
  assert.equal(resolveAssistantModel('auto', {
    anthropic: '', openai: '', openAiCompatibleUrl: 'https://provider.example/api/v1', openAiCompatibleModel: 'model-id',
  }), null, 'Auto never selects a custom provider');
});

test('streamed tool calls execute through Faceclaw, results continue the turn, and history survives follow-up', async () => {
  const h = assistant();
  h.send('Set a one-minute timer');
  const first = h.requests[0];
  h.chunk(first, { content: 'Setting it now.' });
  h.chunk(first, {
    reasoning_content: 'hidden reasoning',
    reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-fixture' }],
    tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'timer_set', arguments: '{"seconds":' } }],
  });
  h.chunk(first, { tool_calls: [{ index: 0, function: { arguments: '60}' } }] });
  h.finish(first, 'tool_calls');
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].name, 'timer.set');
  assert.equal(h.calls[0].args.seconds, 60);
  assert.equal(h.requests.length, 2);
  const second = h.requests[1];
  const assistantMessage = second.body.messages.find(m => m.role === 'assistant' && m.tool_calls);
  assert.equal(assistantMessage.content, 'Setting it now.');
  assert.equal(assistantMessage.tool_calls[0].id, 'call-1');
  assert.equal(assistantMessage.tool_calls[0].function.name, 'timer_set');
  assert.equal(assistantMessage.tool_calls[0].function.arguments, '{"seconds":60}');
  assert.equal(assistantMessage.reasoning_details[0].data, 'opaque-fixture');
  const toolMessage = second.body.messages.find(m => m.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'call-1');
  assert.equal(toolMessage.content, 'timer.set completed');
  assert.equal(JSON.stringify(second.body).includes('hidden reasoning'), false);
  h.chunk(second, { content: 'Your timer is running.' });
  h.finish(second, 'stop', 'close');
  assert.equal(h.session.isTurnActive(), false);
  assert.equal(h.done.length, 1);
  assert.deepEqual(h.errors, []);
  assert.equal(h.deltas.includes('hidden reasoning'), false);
  h.send('What did you set?');
  assert.match(JSON.stringify(h.requests[2].body), /Your timer is running/);
  h.session.cancel();
  assert.equal(h.requests[2].cancelled, true);
});

test('changing the API endpoint preserves visible history but drops provider-specific state', () => {
  const h = assistant();
  const original = h.session.config;
  const config = (baseUrl) => ({ kind: 'direct', llm: {
    selection: 'openai-compatible', provider: 'openai-compatible', model: 'fixture-model', apiKey: 'fixture-key', baseUrl,
  } });
  h.session.sendUtterance('Remember the blue door', {}, {
    onTextDelta() {}, onToolActivity() {}, onError: error => assert.fail(error), onTurnDone() {},
  });
  const first = h.requests[0];
  h.chunk(first, { reasoning_details: [{ type: 'opaque', data: 'server-one-only' }], content: 'Remembered.' });
  h.finish(first);
  const history = JSON.parse(JSON.stringify(h.session.history()));
  assert.equal(JSON.stringify(history).includes('server-one-only'), true);
  h.session.configure(config('https://provider-two.example/api/v1'));
  h.send('What color?');
  const second = h.requests[1];
  assert.equal(second.url, 'https://provider-two.example/api/v1/chat/completions');
  assert.equal(JSON.stringify(second.body).includes('server-one-only'), false);
  assert.equal(JSON.stringify(second.body).includes('Remember the blue door'), true);
  h.session.cancel();
  const restored = new h.session.constructor(config('https://provider-two.example/api/v1'), undefined, history);
  restored.sendUtterance('What color?', {}, {
    onTextDelta() {}, onToolActivity() {}, onError: error => assert.fail(error), onTurnDone() {},
  });
  assert.equal(JSON.stringify(h.requests.at(-1).body).includes('server-one-only'), false);
  restored.cancel();
});

test('multiple interleaved tool calls are reassembled independently and all results are returned', async () => {
  const h = assistant();
  h.send('Set a timer and show an alert');
  const first = h.requests[0];
  h.chunk(first, { tool_calls: [
    { index: 0, id: 'timer-id', function: { name: 'timer_set', arguments: '{"sec' } },
    { index: 1, id: 'alert-id', function: { name: 'glasses_show_alert', arguments: '{"text":' } },
  ] });
  h.chunk(first, { tool_calls: [
    { index: 0, function: { arguments: 'onds":30}' } },
    { index: 1, function: { arguments: '"Done"}' } },
  ] });
  h.finish(first, 'tool_calls');
  await flush();
  // Values produced inside the VM have a different Object prototype.
  assert.equal(JSON.stringify(h.calls.map(c => [c.name, c.args])), JSON.stringify([
    ['timer.set', { seconds: 30 }], ['glasses.show_alert', { text: 'Done' }],
  ]));
  const second = h.requests[1];
  const tools = second.body.messages.filter(m => m.role === 'tool');
  assert.equal(JSON.stringify(tools.map(m => [m.tool_call_id, m.content])), JSON.stringify([
    ['timer-id', 'timer.set completed'], ['alert-id', 'glasses.show_alert completed'],
  ]));
  h.chunk(second, { content: 'Both actions completed.' });
  h.finish(second);
  assert.equal(h.session.isTurnActive(), false);
  assert.deepEqual(h.errors, []);
});

test('content-only streams work with [DONE], while empty and in-band error streams fail clearly', () => {
  const h = assistant();
  h.send('Hello');
  h.chunk(h.requests[0], { role: 'assistant' });
  h.chunk(h.requests[0], { reasoning_content: 'not for the lenses' });
  h.chunk(h.requests[0], { content: 'Hello ' });
  h.chunk(h.requests[0], { content: 'there' });
  h.requests[0].listener.onLine('data: [DONE]');
  assert.equal(h.done[0].stopReason, 'end_turn');
  assert.equal(h.session.transcript.at(-1).text, 'Hello there');

  h.send('Empty'); h.finish(h.requests[1]);
  assert.match(h.errors.at(-1), /without a reply/);
  h.send('Failure');
  h.event(h.requests[2], { error: { message: 'model overloaded' } });
  assert.match(h.errors.at(-1), /model overloaded/);
});

test('HTTP errors, malformed tool JSON and premature EOF never execute incomplete tools', async () => {
  const h = assistant();
  h.send('Unauthorized');
  h.requests[0].listener.onHttpError(401, '{"error":{"message":"bad key"}}');
  assert.match(h.errors.at(-1), /invalid API key/);
  assert.equal(h.session.isTurnActive(), false);

  h.send('Malformed');
  h.chunk(h.requests[1], { tool_calls: [{ index: 0, id: 'bad', function: { name: 'timer_set', arguments: '{broken' } }] });
  h.finish(h.requests[1], 'tool_calls');
  await flush();
  assert.match(h.errors.at(-1), /malformed tool arguments/);
  assert.equal(h.calls.length, 0);

  h.send('Truncated');
  h.chunk(h.requests[2], { tool_calls: [{ index: 0, id: 'partial', function: { name: 'timer_set', arguments: '{"seconds":60}' } }] });
  h.requests[2].listener.onComplete();
  await flush();
  assert.match(h.errors.at(-1), /before the response completed/);
  assert.equal(h.calls.length, 0);

  h.send('Length limited');
  h.chunk(h.requests[3], { tool_calls: [{ index: 0, id: 'partial', function: { name: 'timer_set', arguments: '{"seconds":60}' } }] });
  h.finish(h.requests[3], 'length');
  await flush();
  assert.match(h.errors.at(-1), /before its tool calls completed/);
  assert.equal(h.calls.length, 0);
});

test('cancellation suppresses late deltas and tool side effects', async () => {
  const h = assistant();
  h.send('Cancel this');
  const request = h.requests[0];
  h.session.cancel();
  h.chunk(request, { content: 'late text', tool_calls: [{ index: 0, id: 'late', function: { name: 'timer_set', arguments: '{}' } }] });
  h.finish(request, 'tool_calls');
  await flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.deltas.length, 0);
  assert.equal(h.done.length, 0);
  assert.equal(request.cancelled, true);
});
