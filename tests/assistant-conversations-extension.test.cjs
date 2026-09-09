const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const plain = value => JSON.parse(JSON.stringify(value));
function load(file, imports) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText, { module, exports: module.exports, console, require: name => {
    assert.ok(name in imports, name); return imports[name];
  } });
  return module.exports;
}
const extension = (generation = 1, component = 'fixture/Assistant') => ({ kind: 'extension', component, generation, fallback: null });
const direct = { kind: 'direct', llm: { provider: 'openai', model: 'test', apiKey: 'private-key' } };
const callbacks = () => ({ onTextDelta() {}, onToolActivity() {}, onTurnDone() {}, onError() {} });
function harness(provider) {
  const turns = [];
  const { AssistantSession } = load('app/assistant/session.ts', {
    '../apps/external/extension-providers': { sendExtensionAssistant: provider },
    '../prompts': { buildAssistantSystemPrompt: () => '', describeAssistantContext: () => '' },
    './bridge-client': { assistantBridge: {} },
    './direct-backend': { DirectAssistantBackend: class { runTurn(turn) { turns.push(turn); return { cancel() {} }; } } },
    './tool-registry': { toolRegistry: { listTools: () => [] } },
  });
  const { AssistantConversations } = load('app/assistant/conversations.ts', {
    './session': { AssistantSession }, './models': { ASSISTANT_MODEL_VALUES: ['auto'] },
  });
  return { AssistantSession, AssistantConversations, turns };
}
test('synchronous extension completion or fallback failure never leaves a busy conversation', () => {
  for (const outcome of ['done', 'error', 'fallback']) {
    const { AssistantSession } = harness((_text, cb, fallback) => {
      if (outcome === 'fallback') return fallback();
      if (outcome === 'done') { cb.onTextDelta('answer', 'answer'); cb.onTurnDone({ stopReason: 'end_turn' }); }
      else cb.onError('Rejected');
      return { cancel() {} };
    });
    const session = new AssistantSession(extension());
    session.sendUtterance('question', {}, callbacks());
    assert.equal(session.isTurnActive(), false, outcome);
    session.sendUtterance('next question', {}, callbacks());
    assert.equal(session.transcript.length, 4, outcome);
  }
});
test('cancelled extension callbacks cannot alter saved history or a later turn', () => {
  const requests = []; let cancelled = 0;
  const { AssistantSession } = harness((_text, cb) => { requests.push(cb); return { cancel() { cancelled++; } }; });
  const session = new AssistantSession(extension());
  session.sendUtterance('first', {}, callbacks()); session.cancel();
  session.configure(extension(2)); session.sendUtterance('second', {}, callbacks());
  const before = plain(session.history());
  requests[0].onTextDelta('stale', 'stale'); requests[0].onError('stale'); requests[0].onTurnDone({});
  assert.deepEqual(plain(session.history()), before); assert.equal(session.isTurnActive(), true); assert.equal(cancelled, 1);
  requests[1].onTextDelta('fresh', 'fresh'); requests[1].onTurnDone({});
  assert.equal(session.transcript.at(-1).text, 'fresh'); assert.equal(session.isTurnActive(), false);
});
test('provider identity changes preserve visible history and discard opaque engine items', () => {
  const { AssistantSession } = harness(() => ({ cancel() {} }));
  for (const next of [extension(2), extension(1, 'other/Assistant'), direct]) {
    const history = { engine: 'extension:fixture/Assistant:1', messages: [{ role: 'assistant', content: 'opaque' }],
      transcript: [{ role: 'user', text: 'question' }, { role: 'assistant', text: 'answer' }] };
    const session = new AssistantSession(extension(), undefined, history);
    session.configure(next);
    assert.deepEqual(plain(session.history().messages), [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' }]);
    const restored = new AssistantSession(next, undefined, history);
    assert.deepEqual(plain(restored.history().messages), plain(session.history().messages));
  }
});
test('persistent conversations reuse extension turns, reject switching while active and save no configuration credentials', () => {
  const requests = []; let saved = '', config = extension();
  const { AssistantConversations } = harness((_text, cb) => { requests.push(cb); return { cancel() {} }; });
  const conversations = new AssistantConversations(() => config, () => 'auto', value => saved = value);
  const first = conversations.ensureSession(); first.sendUtterance('remember this', {}, callbacks());
  assert.equal(conversations.create(), false); assert.equal(conversations.configure('auto', 'high'), false);
  requests[0].onTextDelta('remembered', 'remembered'); requests[0].onTurnDone({});
  assert.equal(conversations.ensureSession(), first);
  const restored = new AssistantConversations(() => config, () => 'auto', () => {}, saved);
  assert.deepEqual(plain(restored.ensureSession().transcript), plain(first.transcript));
  config = direct; assert.equal(conversations.configure('auto', 'high'), true);
  assert.equal(saved.includes('private-key'), false); assert.equal(saved.includes('apiKey'), false);
  assert.equal(conversations.create(), true); assert.equal(conversations.list().length, 2);
});
