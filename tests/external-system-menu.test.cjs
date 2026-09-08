const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function setup() {
 const module = { exports: {} }, opened = []; let locked = false, screenOn = true, overlayAllowed = true, foreground = 'own-window', now = 100000;
 const shell = { isScreenOn: () => screenOn, foregroundWindow: () => ({ windowId: foreground }), canShowExtensionOverlay: () => overlayAllowed,
  openSystemMenu(id) { assert.equal(state.lastInput, 0, 'Consume gesture before entering host menu'); opened.push(id); } };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/apps/external/platform.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText,
  { module, exports: module.exports, require: name => name === '../../ui/shell/shell' ? { shell } : {}, Date: { now: () => now }, global: { isAndroid: false } });
 const platform = Object.create(module.exports.ExternalAppPlatform.prototype);
 const state = { window: { windowId: 'own-window' }, ready: true, visible: true, lastInput: now };
 platform.extensions = { onNativeEvent: () => false }; platform.windows = new Map([['own-app', state]]); platform.options = { isLocked: () => locked };
 return { platform, state, opened, request: (component = 'own-app', data = {}) => platform.onEvent(component, 'request-system-menu', data),
  setLocked: value => locked = value, setScreen: value => screenOn = value, setOverlayAllowed: value => overlayAllowed = value, setForeground: value => foreground = value, advance: value => now += value };
}

test('system menu uses only the requesting foreground window and a single fresh gesture', () => {
 const h = setup(); h.request('own-app', { windowId: 'foreign-window', action: 'close' });
 assert.deepEqual(h.opened, ['own-window']); h.request(); assert.equal(h.opened.length, 1);
 h.state.lastInput = 100000; h.advance(5000); h.request(); assert.equal(h.opened.length, 2);
});

test('system menu rejects hidden, stale, locked, protected and competing host work', () => {
 for (const deny of [h => h.state.ready = false, h => h.state.visible = false, h => h.setForeground('foreign-window'), h => h.setLocked(true), h => h.setScreen(false),
  h => h.state.protected = true, h => h.state.reviewId = 'review', h => h.state.cancelReview = () => {}, h => h.state.refinement = {}, h => h.setOverlayAllowed(false),
  h => h.state.lastInput = 0, h => h.advance(5001), h => h.advance(-1), h => h.platform.windows.delete('own-app')]) {
  const h = setup(); deny(h); h.request(); assert.deepEqual(h.opened, []);
 }
 const h = setup(); h.request('unrelated-app'); assert.deepEqual(h.opened, []); assert.equal(h.state.lastInput, 100000);
});
