const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
// Values built inside the loader's VM context have that realm's prototypes.
const plain = value => JSON.parse(JSON.stringify(value));

/** A stand-in for FaceclawSystemLanguageModel.swift: records requests and lets tests emit its events. */
function fakeNative(availability = 'available') {
  const instances = [];
  const cls = {
    availability: () => availability,
    new() {
      const native = {
        request: null, resolved: [], cancelled: false, eventHandler: null,
        start(json) { this.request = JSON.parse(json); },
        resolveToolCalls(json) { this.resolved.push(JSON.parse(json)); },
        cancel() { this.cancelled = true; },
        emit(event) { if (this.eventHandler) this.eventHandler(JSON.stringify(event)); },
      };
      instances.push(native);
      return native;
    },
  };
  return { cls, instances, setAvailability(value) { availability = value; } };
}

function loadLocalLlm(native, extraGlobals = {}) {
  const load = loader({ FaceclawSystemLanguageModel: native.cls, setTimeout, clearTimeout, ...extraGlobals }, {});
  return load('app/native/local-llm.ios.ts');
}

function collector() {
  const seen = { deltas: [], done: [], errors: [] };
  return {
    seen,
    callbacks: {
      onTextDelta: (_delta, full) => seen.deltas.push(full),
      onDone: result => seen.done.push(result),
      onError: message => seen.errors.push(message),
    },
  };
}

test('iOS local LLM converts provider-neutral history into transcript entries and a final prompt', () => {
  const api = loadLocalLlm(fakeNative());
  const request = api.buildSystemModelRequest({
    system: 'Be brief.',
    maxTokens: 200,
    tools: [{ name: 'timer_set', description: 'Set a timer', input_schema: { type: 'object', properties: { seconds: { type: 'integer' } } } }],
    messages: [
      { role: 'user', content: 'Set a timer' },
      { role: 'assistant', content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'fm_1', name: 'timer_set', input: { seconds: 60 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fm_1', content: 'Timer set' }] },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'boom', is_error: true }, { type: 'text', text: 'And now?' }] },
      { role: 'assistant', content: [{ type: 'provider_item', provider: 'openai', item: {} }] },
      { role: 'user', content: 'What time is it?' },
    ],
  });
  assert.equal(request.system, 'Be brief.');
  assert.equal(request.prompt, 'What time is it?');
  assert.equal(request.maxTokens, 200);
  assert.equal(request.permissive, false);
  assert.deepEqual(plain(request.tools), [{ name: 'timer_set', description: 'Set a timer', parameters: { type: 'object', properties: { seconds: { type: 'integer' } } } }]);
  assert.deepEqual(plain(request.history), [
    { type: 'prompt', text: 'Set a timer' },
    { type: 'response', text: 'On it.' },
    { type: 'toolCalls', calls: [{ id: 'fm_1', name: 'timer_set', arguments: '{"seconds":60}' }] },
    { type: 'toolOutput', id: 'fm_1', name: 'timer_set', text: 'Timer set' },
    { type: 'response', text: 'Done.' },
    { type: 'toolOutput', id: 'gone', name: 'tool', text: 'Error: boom' },
    { type: 'prompt', text: 'And now?' },
  ]);

  // Tool-free requests (translate, Q&A) get the permissive guardrails; a
  // trailing tool result with nothing to resume falls back to a continuation prompt.
  const orphan = api.buildSystemModelRequest({
    messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] }],
  });
  assert.equal(orphan.permissive, true);
  assert.equal(orphan.maxTokens, 512);
  assert.equal(orphan.prompt, api.CONTINUE_PROMPT);
  assert.deepEqual(plain(orphan.history.at(-1)), { type: 'toolOutput', id: 'a', name: 't', text: 'ok' });
});

test('iOS local LLM streams text deltas, then ends the turn', () => {
  const native = fakeNative();
  const api = loadLocalLlm(native);
  const { seen, callbacks } = collector();
  api.streamLocalModel({ apiKey: '', model: 'm', system: 's', messages: [{ role: 'user', content: 'Hi' }], ...callbacks });
  const [instance] = native.instances;
  assert.equal(instance.request.prompt, 'Hi');
  instance.emit({ kind: 'log', message: 'shortened tool descriptions' });
  instance.emit({ kind: 'delta', text: 'Hello' });
  instance.emit({ kind: 'delta', text: ' there' });
  instance.emit({ kind: 'done' });
  instance.emit({ kind: 'delta', text: 'late' });
  assert.deepEqual(plain(seen.deltas), ['Hello', 'Hello there']);
  assert.equal(seen.done.length, 1);
  assert.deepEqual(plain(seen.done[0]), { text: 'Hello there', content: [{ type: 'text', text: 'Hello there' }], stopReason: 'end_turn' });
  assert.equal(instance.eventHandler, null, 'finished generations drop their handler');
});

test('iOS local LLM reports why the model is unavailable without touching native code', async () => {
  const native = fakeNative('appleIntelligenceNotEnabled');
  const api = loadLocalLlm(native);
  assert.equal(api.isLocalModelReady(), false);
  assert.equal(api.isLocalModelSupported(), true);
  assert.deepEqual(plain(api.localModelState()), { status: 'unavailable', bytesDownloaded: 0, totalBytes: 0, detail: 'Apple Intelligence off' });
  const { seen, callbacks } = collector();
  api.streamLocalModel({ apiKey: '', model: 'm', messages: [{ role: 'user', content: 'Hi' }], ...callbacks });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(seen.errors[0], /Turn on Apple Intelligence/);
  assert.equal(native.instances.length, 0);

  native.setAvailability('deviceNotEligible');
  assert.equal(api.isLocalModelSupported(), false);
  native.setAvailability('somethingNew');
  assert.equal(api.localModelState().detail, 'unavailable');
  const missing = loader({ setTimeout, clearTimeout }, {})('app/native/local-llm.ios.ts');
  assert.equal(missing.localModelAvailability(), 'unsupportedOS', 'pre-iOS-26 builds have no Swift class to call');
  native.setAvailability('available');
  assert.deepEqual(plain(api.localModelState()), { status: 'ready', bytesDownloaded: 0, totalBytes: 0 });
});

test('iOS local LLM maps refusals to the refusal stop reason and other failures to errors', () => {
  const native = fakeNative();
  const api = loadLocalLlm(native);
  const first = collector();
  api.streamLocalModel({ apiKey: '', model: 'm', messages: [{ role: 'user', content: 'x' }], ...first.callbacks });
  native.instances[0].emit({ kind: 'error', code: 'refusal', message: 'declined' });
  assert.equal(first.seen.done[0].stopReason, 'refusal');
  const second = collector();
  api.streamLocalModel({ apiKey: '', model: 'm', messages: [{ role: 'user', content: 'x' }], ...second.callbacks });
  native.instances[1].emit({ kind: 'error', code: 'rateLimited', message: 'iOS is limiting the on-device model' });
  assert.deepEqual(plain(second.seen.errors), ['iOS is limiting the on-device model']);
});

test('iOS local LLM cancellation stops the native generation and silences later events', () => {
  const native = fakeNative();
  const api = loadLocalLlm(native);
  const { seen, callbacks } = collector();
  const handle = api.streamLocalModel({ apiKey: '', model: 'm', messages: [{ role: 'user', content: 'x' }], ...callbacks });
  handle.cancel();
  native.instances[0].emit({ kind: 'delta', text: 'late' });
  native.instances[0].emit({ kind: 'done' });
  assert.equal(native.instances[0].cancelled, true);
  assert.deepEqual(seen, { deltas: [], done: [], errors: [] });
});

test('iOS assistant runs the on-device model through the shared tool loop, resuming the parked generation', async () => {
  const native = fakeNative();
  const calls = [], deltas = [], errors = [], done = [];
  const registry = {
    listTools: () => [{ name: 'timer.set', description: 'Set a timer', inputSchema: { type: 'object', properties: { seconds: { type: 'integer' } }, required: ['seconds'] } }],
    callTool: async (name, args) => { calls.push({ name, args }); return { ok: true, content: 'Timer set' }; },
  };
  const mocks = {
    './bridge-client': { assistantBridge: {} }, './tool-registry': { toolRegistry: registry },
    '../prompts': { ASSISTANT_SYSTEM_PROMPT_BASE: 'base prompt', buildAssistantSystemPrompt: () => 'cloud prompt', describeAssistantContext: () => 'Context: now' },
  };
  const load = loader({ global: { isIOS: true, isAndroid: false }, FaceclawSystemLanguageModel: native.cls, setTimeout, clearTimeout }, mocks);
  mocks['../native/local-llm'] = load('app/native/local-llm.ios.ts');
  const { AssistantSession } = load('app/assistant/session.ts');
  const session = new AssistantSession({ kind: 'direct', llm: { selection: 'qwen', provider: 'local', model: 'apple-foundation-model', apiKey: '' } }, registry);
  const send = text => session.sendUtterance(text, {}, { onTextDelta: (_d, full) => deltas.push(full),
    onToolActivity() {}, onError: error => errors.push(error), onTurnDone: result => done.push(result) });

  send('Set a one-minute timer');
  assert.equal(native.instances.length, 1);
  const generation = native.instances[0];
  assert.equal(generation.request.system, 'base prompt', 'the local provider keeps the system prompt stable');
  assert.equal(generation.request.prompt, 'Set a one-minute timer\n\n(Context: now)');
  assert.deepEqual(plain(generation.request.tools.map(tool => tool.name)), ['timer_set']);

  generation.emit({ kind: 'toolCalls', calls: [{ id: 'fm_abc', name: 'timer_set', arguments: '{"seconds":60}' }] });
  await flush();
  assert.deepEqual(plain(calls), [{ name: 'timer.set', args: { seconds: 60 } }]);
  assert.equal(native.instances.length, 1, 'tool results resume the parked generation instead of starting another');
  assert.deepEqual(plain(generation.resolved), [[{ id: 'fm_abc', content: 'Timer set', isError: false }]]);

  generation.emit({ kind: 'delta', text: 'Your timer is running.' });
  generation.emit({ kind: 'done' });
  assert.equal(done.length, 1);
  assert.equal(errors.length, 0);
  assert.equal(deltas.at(-1), 'Your timer is running.');
  assert.equal(session.isTurnActive(), false);

  // The next turn starts a fresh generation that carries the whole exchange as transcript history.
  send('Thanks');
  const next = native.instances[1];
  assert.deepEqual(plain(next.request.history), [
    { type: 'prompt', text: 'Set a one-minute timer\n\n(Context: now)' },
    { type: 'toolCalls', calls: [{ id: 'fm_abc', name: 'timer_set', arguments: '{"seconds":60}' }] },
    { type: 'toolOutput', id: 'fm_abc', name: 'timer_set', text: 'Timer set' },
    { type: 'response', text: 'Your timer is running.' },
  ]);
  session.cancel();
  assert.equal(next.cancelled, true);
});

test('a parked iOS generation survives unrelated requests and is abandoned if its results never arrive', () => {
  const native = fakeNative();
  let expire = null;
  const timers = {
    setTimeout: (fn, ms) => { if (ms > 0) expire = fn; else fn(); return 1; },
    clearTimeout: () => { expire = null; },
  };
  const api = loadLocalLlm(native, timers);
  const turn = collector();
  api.streamLocalModel({ apiKey: '', model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [], ...turn.callbacks });
  native.instances[0].emit({ kind: 'toolCalls', calls: [{ id: 'fm_1', name: 't', arguments: 'not json' }] });
  assert.deepEqual(plain(turn.seen.done[0].content), [{ type: 'tool_use', id: 'fm_1', name: 't', input: {} }]);

  // e.g. Translate asking the model something while the assistant's tool runs.
  const other = collector();
  api.streamLocalModel({ apiKey: '', model: 'm', messages: [{ role: 'user', content: 'translate this' }], ...other.callbacks });
  assert.equal(native.instances.length, 2);
  assert.equal(native.instances[0].cancelled, false);

  assert.equal(typeof expire, 'function');
  expire();
  assert.equal(native.instances[0].cancelled, true);
  // Results for the abandoned call now start a fresh generation with the fallback prompt.
  api.streamLocalModel({ apiKey: '', model: 'm', ...turn.callbacks, messages: [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: turn.seen.done[0].content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fm_1', content: 'ok' }] },
  ] });
  assert.equal(native.instances.length, 3);
  assert.equal(native.instances[2].request.prompt, api.CONTINUE_PROMPT);
});

test('iOS offers the on-phone model where Apple Intelligence is supported', () => {
  const local = { LOCAL_MODEL: { label: 'Apple Intelligence', id: 'apple-foundation-model' }, isLocalModelReady: () => true, isLocalModelSupported: () => true };
  const api = loader({ global: { isIOS: true } }, { '../native/local-llm': local })('app/assistant/models.ts');
  assert.equal(api.ASSISTANT_MODEL_CHOICES.includes('qwen'), true);
  assert.equal(api.supportedAssistantModel('qwen'), 'qwen');
  assert.equal(api.assistantModelLabel('qwen'), 'Apple Intelligence (on-phone)');
  const resolved = api.resolveAssistantModel('auto', { openai: '', anthropic: '' });
  assert.equal(resolved.provider, 'local');
  assert.equal(resolved.model, 'apple-foundation-model');
  assert.equal(api.resolveAssistantModel('auto', { openai: 'key', anthropic: '' }).provider, 'openai', 'API keys still win under Auto');
  local.isLocalModelReady = () => false;
  assert.equal(api.resolveAssistantModel('qwen', { openai: '', anthropic: '' }), null);
});
