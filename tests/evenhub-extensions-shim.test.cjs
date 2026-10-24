const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The injected shim (app/apps/evenhub/session.ts) and the published types
// (evenhub-extensions/src/index.ts) describe the same API from two sides.
const source = fs.readFileSync(path.join(__dirname, '../app/apps/evenhub/session.ts'), 'utf8');
const template = source.match(/export function buildFaceclawExtensionsScript[^`]*`([\s\S]*?)`;\n}/)[1];
const shim = template.replace('${JSON.stringify(versionString)}', JSON.stringify('Faceclaw/9.9.9'));
const types = fs.readFileSync(path.join(__dirname, '../evenhub-extensions/src/index.ts'), 'utf8');

function interfaceMembers(name) {
  const body = types.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`))[1];
  const withoutComments = body.replace(/\/\*\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/^ {2}(?:readonly )?(\w+)[?(:]/gm)].map((m) => m[1]).sort();
}

function page() {
  const posted = [];
  const win = {
    console, JSON, Promise, Array, Object, Error, String,
    __faceclawEvenHub: { postMessage(name, argsJson, id) { posted.push({ name, args: JSON.parse(argsJson), id }); } },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(shim, win);
  const fc = win.getFaceclawExtensions();
  return { win, fc, posted };
}

test('the shim implements exactly the members the package declares', () => {
  const { fc } = page();
  assert.deepEqual(Object.keys(fc).sort(), interfaceMembers('FaceclawExtensions'));
});

test('version and api level are available synchronously', () => {
  const { fc } = page();
  assert.equal(fc.getVersion(), 'Faceclaw/9.9.9');
  assert.equal(fc.apiVersion, 1);
});

test('calls resolve with the host value and reject with an Error', async () => {
  const { win, fc, posted } = page();
  const ok = fc.getConfiguredApiKeys();
  const bad = fc.playBuzzer([{ freq: 440, ms: 100 }]);
  assert.deepEqual(posted.map((p) => [p.name, p.args[0]]), [['faceclawExt', 'getConfiguredApiKeys'], ['faceclawExt', 'playBuzzer']]);
  assert.ok(posted.every((p) => p.id > 0));
  win.__fcExtResolve(posted[0].id, true, ['openai']);
  win.__fcExtResolve(posted[1].id, false, 'no glasses');
  assert.deepEqual(await ok, ['openai']);
  await assert.rejects(bad, (error) => error instanceof win.Error && error.message === 'no glasses');
});

test('fire-and-forget calls use id 0', () => {
  const { fc, posted } = page();
  fc.returnToAppSwitcher();
  fc.quit();
  assert.deepEqual(posted.map((p) => [p.args[0], p.id]), [['returnToAppSwitcher', 0], ['quit', 0]]);
});

test('a listener that unsubscribes during dispatch does not skip the next one', () => {
  const { win, fc } = page();
  const seen = [];
  const offA = fc.addWindowLifecycleListener((e) => { seen.push(`a:${e.type}`); offA(); });
  fc.addWindowLifecycleListener((e) => seen.push(`b:${e.type}`));
  win.__fcExtEvent('windowLifecycle', { type: 'hidden' });
  win.__fcExtEvent('windowLifecycle', { type: 'visible' });
  assert.deepEqual(seen, ['a:hidden', 'b:hidden', 'b:visible']);
});

test('the compass is enabled for the first listener and disabled after the last', () => {
  const { win, fc, posted } = page();
  const readings = [];
  const off1 = fc.addCompassListener((r) => readings.push(r.headingDegrees));
  const off2 = fc.addCompassListener(() => {});
  win.__fcExtEvent('compass', { headingDegrees: 90 });
  off1();
  off2();
  assert.deepEqual(readings, [90]);
  assert.deepEqual(posted.map((p) => p.args), [['setCompass', true], ['setCompass', false]]);
});

test('assistant tools send specs to the host and run handlers on invoke', async () => {
  const { win, fc, posted } = page();
  fc.setAssistantTools([
    { name: 'double', description: 'Doubles n', handler: ({ n }) => n * 2 },
    { name: 'fail', description: 'Throws', availability: 'open', handler: () => { throw new Error('nope'); } },
  ]);
  assert.deepEqual(posted[0].args, ['setAssistantTools', [
    { name: 'double', description: 'Doubles n', parameters: { type: 'object', properties: {} }, availability: 'foreground' },
    { name: 'fail', description: 'Throws', parameters: { type: 'object', properties: {} }, availability: 'open' },
  ]]);
  win.__fcExtInvokeTool(7, 'double', { n: 21 });
  win.__fcExtInvokeTool(8, 'fail', {});
  win.__fcExtInvokeTool(9, 'missing', {});
  await new Promise((resolve) => setImmediate(resolve));
  const results = posted.filter((p) => p.name === 'faceclawExtToolResult').map((p) => p.args).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(results, [[7, true, 42], [8, false, 'nope'], [9, false, 'unknown tool missing']]);
});

test('touch-down and text input are requested while someone listens, and unsubscribing twice is harmless', () => {
  const { win, fc, posted } = page();
  const seen = [];
  const offTouch = fc.addTouchDownListener((e) => seen.push(`touch:${e.source}`));
  const offText1 = fc.addTextInputListener((e) => seen.push(`text1:${e.text}`));
  const offText2 = fc.addTextInputListener((e) => seen.push(`text2:${e.text}`));
  win.__fcExtEvent('touchDown', { source: 'watch', timestampMs: 5 });
  win.__fcExtEvent('textInput', { text: 'hi' });
  offText1();
  offText1();
  win.__fcExtEvent('textInput', { text: 'again' });
  offText2();
  offTouch();
  assert.deepEqual(seen, ['touch:watch', 'text1:hi', 'text2:hi', 'text2:again']);
  assert.deepEqual(posted.map((p) => p.args), [
    ['setTouchDown', true],
    ['setTextInput', true],
    ['setTextInput', false],
    ['setTouchDown', false],
  ]);
});

test('window icons are sent as plain arrays, and clearing sends null', async () => {
  const { win, fc, posted } = page();
  const set = fc.setWindowIcon({ width: 1, height: 2, data: new Uint8ClampedArray([7, 9]) });
  const clear = fc.setWindowIcon(null);
  assert.deepEqual(posted.map((p) => p.args), [
    ['setWindowIcon', { width: 1, height: 2, data: [7, 9] }],
    ['setWindowIcon', null],
  ]);
  win.__fcExtResolve(posted[0].id, true, null);
  win.__fcExtResolve(posted[1].id, false, 'setWindowIcon: bad');
  await set;
  await assert.rejects(clear, /setWindowIcon: bad/);
});

test('window controls are fire-and-forget; startVoiceInput resolves the host answer', async () => {
  const { win, fc, posted } = page();
  fc.setAttention(1);
  fc.setKeepScreenOn(false);
  const voice = fc.startVoiceInput();
  assert.deepEqual(posted.map((p) => [p.args, p.id === 0]), [
    [['setAttention', true], true],
    [['setKeepScreenOn', false], true],
    [['startVoiceInput'], false],
  ]);
  win.__fcExtResolve(posted[2].id, true, false);
  assert.equal(await voice, false);
});

test('font queries are calls; measureText sends null for no font', () => {
  const { fc, posted } = page();
  void fc.getFonts();
  void fc.measureText('hi');
  void fc.measureText(42, { family: 'Inter', size: 30 });
  assert.deepEqual(posted.map((p) => p.args), [
    ['getFonts'],
    ['measureText', 'hi', null],
    ['measureText', '42', { family: 'Inter', size: 30 }],
  ]);
  assert.ok(posted.every((p) => p.id > 0));
});
