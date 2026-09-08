const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function setup() {
  const module = { exports: {} }, listeners = {}, timers = new Map(), result = { queries: [], starts: 0, stops: 0, closed: 0 };
  const imports = {
    '../../native/voice-control': { voiceControlBridge: Object.fromEntries(['Transcript', 'Status'].map(name => [`on${name}`, callback => { listeners[name] = callback; return () => { listeners[name] = null; }; }])) },
    '../gestures': { gestureHints: () => '' }, './input-dialog': { paintInputDialog: () => {} },
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/ui/shell/voice-search.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, require: name => imports[name] || {}, setTimeout: callback => { const id = {}; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) });
  const layer = new module.exports.VoiceSearchLayer({ label: 'Search by name', actions: { requestRender() {}, startVoiceCapture() { result.starts++; }, stopVoiceCapture() { result.stops++; } },
    onSearch: query => result.queries.push(query), dismiss: () => layer.onRemoved(), onClosed: () => result.closed++ });
  layer.startCapture();
  return { layer, result, listeners, timers, transcript: (text, isFinal) => listeners.Transcript?.({ text, isFinal }), click: () => layer.handleInput({ type: 'click' }) };
}

test('voice search requires final transcript and Search confirmation, with no send/refine actions', () => {
  const h = setup(); h.transcript('partial user name', false); h.click(); h.click(); assert.deepEqual(h.result.queries, []);
  h.transcript('Élodie', true); assert.deepEqual(h.result.queries, []);
  assert.equal(JSON.stringify(h.layer.rows().map(row => row.label)), JSON.stringify(['Search', 'Try again', 'Cancel']));
  h.click(); h.click(); assert.deepEqual(h.result.queries, ['Élodie']); assert.equal(h.result.closed, 1);
});
test('voice search timeout, empty final, oversized query and speaker rejection never use partials', () => {
  for (const finish of [h => [...h.timers.values()][0](), h => h.transcript('', true), h => h.transcript('x'.repeat(257), true), h => h.listeners.Status({ status: 'Ignored speaker' })]) {
    const h = setup(); h.transcript('must not search', false); h.click(); finish(h); h.click();
    assert.deepEqual(h.result.queries, []); h.layer.onRemoved();
  }
});
test('retry clears prior query and cancellation ignores all late capture callbacks', () => {
  const h = setup(); h.click(); h.transcript('Old name', true); const previous = h.layer.text;
  h.layer.handleInput({ type: 'scroll-down' }); h.click(); assert.equal(h.result.starts, 2); assert.equal(h.layer.text, '');
  const queued = h.listeners.Transcript; h.layer.handleInput({ type: 'double-click' });
  queued({ text: previous, isFinal: true }); h.click(); h.layer.startCapture();
  assert.deepEqual(h.result.queries, []); assert.equal(h.layer.text, ''); assert.equal(h.result.closed, 1); assert.equal(h.result.starts, 2);
});

test('empty or oversized final highlights Try again instead of disabled Search', () => {
 for (const text of ['', 'x'.repeat(257)]) {
  const h = setup(); h.click(); h.transcript(text, true);
  assert.equal(h.layer.rows()[h.layer.selected].label, 'Try again');
  h.click(); assert.equal(h.result.starts, 2); assert.deepEqual(h.result.queries, []); h.layer.onRemoved();
 }
});
