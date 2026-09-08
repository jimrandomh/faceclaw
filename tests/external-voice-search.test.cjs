const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function setup() {
 const module = { exports: {} }, calls = [], requests = []; let allowed = true, locked = false, screenOn = true, now = 100000;
 const shell = { isScreenOn: () => screenOn, startExternalAppSearch(...args) { requests.push(args); return () => args[3](); } };
 const imports = { '@nativescript/core': {}, '../../ui/shell/shell': { shell } };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/apps/external/platform.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText,
  { module, exports: module.exports, require: name => imports[name] || {}, Date: { now: () => now }, global: { isAndroid: false } });
 const platform = Object.create(module.exports.ExternalAppPlatform.prototype);
 platform.extensions = { onNativeEvent: () => false };
 const state = { window: { windowId: 'window' }, ready: true, visible: true, lastInput: now };
 platform.windows = new Map([['app', state]]); platform.options = { isLocked: () => locked };
 platform.native = { allows: () => allowed, send: (component, type, json) => calls.push({ component, type, data: JSON.parse(json) }) };
 const data = { requestId: 'search-id', target: 'directory', label: 'Search by name' };
 return { platform, state, calls, requests, data, begin: () => platform.onEvent('app', 'search-dictation', data),
  setAllowed: value => allowed = value, setLocked: value => locked = value, setScreen: value => screenOn = value, advance: value => now += value };
}
test('voice search requires a fresh visible granted gesture and consumes it before permission wait', () => {
 for (const deny of [h => h.advance(5001), h => h.state.visible = false, h => h.state.ready = false, h => h.setAllowed(false), h => h.setLocked(true), h => h.setScreen(false)]) {
  const h = setup(); deny(h); h.begin(); assert.equal(h.requests.length, 0); assert.equal(h.calls[0].type, 'search-dictation-rejected');
 }
 const h = setup(); h.begin(); assert.equal(h.state.lastInput, 0); assert.equal(h.requests[0][4](), true); h.advance(5001); assert.equal(h.requests[0][4](), false);
});
test('search completion cannot enter send review and is bound to window, grant, one use and purpose', () => {
 const h = setup(); h.begin(); const complete = h.requests[0][2];
 h.platform.onEvent('app', 'cancel-dictation', { requestId: 'search-id' }); assert.equal(h.state.reviewPurpose, 'search');
 complete('Élodie'); complete('Second result'); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].type, 'search-dictation-result');
 assert.equal(h.calls[0].data.target, 'directory'); assert.equal(h.calls[0].data.text, 'Élodie');
 for (const invalidate of [h => h.platform.windows.delete('app'), h => h.setAllowed(false), h => h.state.visible = false, h => h.advance(300001)]) {
  const h = setup(); h.begin(); invalidate(h); h.requests[0][2]('Late query'); assert.equal(h.calls.length, 0);
 }
});
test('search cancellation and message cancellation cannot cross purposes', () => {
 const h = setup(); h.begin(); h.platform.onEvent('app', 'cancel-search-dictation', { requestId: 'search-id' });
 h.requests[0][2]('Late query'); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].type, 'search-dictation-rejected');
 let cancelled = 0; h.state.reviewPurpose = 'message'; h.state.reviewId = 'same-id'; h.state.cancelReview = () => cancelled++;
 h.platform.onEvent('app', 'cancel-search-dictation', { requestId: 'same-id' }); assert.equal(cancelled, 0);
 h.platform.onEvent('app', 'cancel-dictation', { requestId: 'same-id' }); assert.equal(cancelled, 1);
});
