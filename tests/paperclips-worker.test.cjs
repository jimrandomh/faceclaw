const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loader } = require('./helpers/load-typescript.cjs');

function fixture({ ios = false, connected = true } = {}) {
  const messages = [], frames = [], sounds = [], errors = [], timers = new Set(), settings = new Map();
  const global = { isIOS: ios, isAndroid: !ios, postMessage: message => messages.push(message) };
  const timings = {
    startFrame: () => 1, finishFrame() {}, logFrame() {},
    span: (_id, _name, fn) => fn(), runWithFrame: (_id, fn) => fn(), spanCurrent: (_name, fn) => fn(),
  };
  const mocks = {
    '@nativescript/core': {}, '@nativescript/core/globals': {},
    '../../native/frame-timings': timings, '../native/frame-timings': timings,
    '../../native/settings-store': {
      getBooleanSetting: (key, fallback) => settings.get(key) ?? fallback,
      setBooleanSetting: (key, value) => settings.set(key, value),
    },
  };
  mocks['../native/settings-store'] = mocks['../../native/settings-store'];
  const display = { submitSurfaceFrame: (...args) => frames.push(args) };
  let active = connected;
  const load = loader({
    global, setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
    console: { log() {}, warn: error => errors.push(error), error: error => errors.push(error) },
    com: { faceclaw: { app: {
      FaceclawBleCommunicator: { getActive: () => active ? {
        ...display, playBuzzerSequence: payload => sounds.push(payload),
      } : null },
      FaceclawPreviewCompositor: { getActive: () => display },
    } } },
    NSData: { dataWithBytesLength: buffer => ({ base64EncodedStringWithOptions: () => Buffer.from(buffer).toString('base64') }) },
    interop: { handleof: buffer => buffer },
  }, mocks);
  const { BdfFont } = load('app/graphics/bdffont.ts');
  const font = size => BdfFont.parse(fs.readFileSync(path.join(__dirname, `../app/fonts/terminus/ter-u${size}n.bdf`), 'utf8'));
  const small = font(12), medium = font(24);
  mocks['../../graphics/bdffont'] = { getFont: () => medium };
  mocks['../../graphics/ui-fonts'] = mocks['../graphics/ui-fonts'] = { getDefaultSmallFont: () => small };
  // Exercise the real iOS transport and Android preview selection. The atlas
  // boundary is stubbed; text baking and plane composition remain production code.
  mocks['../../graphics/glyph-wire'] = { prepareFrameDraws: () => null };
  if (ios) mocks['../../native/active-display'] = load('app/native/active-display.ios.ts');
  load('app/apps/paperclips/paperclips-app.worker.ts');
  const send = data => global.onmessage({ data });
  const input = type => send({ type: 'input', windowId: 'paperclips:main', focused: true, frameId: 1,
    event: { type, source: 'ring', timestampMs: 1 } });
  const open = () => {
    send({ type: 'open-window', windowId: 'paperclips:main', surfaceId: 'window:paperclips:main',
      title: 'Paperclips', viewport: { width: 576, height: 260 } });
    send({ type: 'foreground', windowId: 'paperclips:main', foreground: true, focused: true });
  };
  const pixels = () => ios ? Buffer.from(messages.filter(m => m.type === 'surface-frame').at(-1).pixels, 'base64')
    : Buffer.from(frames.at(-1)[0]);
  return { messages, frames, sounds, errors, timers, settings, send, input, open, pixels,
    disconnect: () => { active = false; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

for (const ios of [false, true]) {
  test(`Paperclips starts, renders text and plays sound through the ${ios ? 'iOS' : 'Android'} bridge`, () => {
    const h = fixture({ ios });
    assert.equal(h.messages[0].type, 'worker-ready');
    h.open();
    assert.equal(h.timers.size, 1);
    assert.equal(h.pixels().length, 576 * 260);
    assert.ok(h.pixels().some(value => value > 0));
    const first = h.pixels();
    h.input('click');
    assert.notDeepEqual(h.pixels(), first);
    h.input('long-press');
    assert.equal(h.timers.size, 0);
    assert.ok(ios ? h.messages.some(m => m.type === 'buzzer-sequence' && m.payload.length) : h.sounds.length);
    const gestures = h.messages.filter(m => m.type === 'set-window-gestures');
    assert.equal(gestures[0].claimsLongPress, true);
    assert.equal(gestures.at(-1).claimsLongPress, false);
    // The gap between the pause title and hints must occlude the deferred
    // game labels below, rather than letting them draw over the modal.
    const pixels = h.pixels();
    for (let y = 124; y < 136; y++) {
      assert.ok(pixels.subarray(y * 576 + 132, y * 576 + 444).every(value => value === 0));
    }
    h.input('click');
    assert.equal(h.timers.size, 1);
    h.send({ type: 'close-window', windowId: 'paperclips:main' });
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.errors, []);
  });
}

test('Paperclips uses the disconnected preview and suppresses duplicate frames', () => {
  const h = fixture({ connected: false });
  h.open();
  assert.equal(h.frames.length, 1);
  h.send({ type: 'render', windowId: 'paperclips:main', focused: true });
  assert.equal(h.frames.length, 1);
  h.input('click');
  assert.equal(h.frames.length, 2);
  assert.deepEqual(h.errors, []);
});

test('Paperclips pauses for focus loss and its current context menu resumes and saves sound settings', async () => {
  const h = fixture(); h.open();
  h.send({ type: 'input-focus', windowId: 'paperclips:main', focused: false });
  assert.equal(h.timers.size, 0);
  h.input('short-then-long-press');
  h.input('click'); await flush(); // Resume
  assert.equal(h.timers.size, 1);
  h.input('short-then-long-press');
  assert.equal(h.timers.size, 0);
  for (let i = 0; i < 3; i++) { h.input('scroll-down'); await flush(); }
  h.input('click'); await flush(); // Sound: off
  assert.equal(h.settings.get('paperclips.soundOn'), false);
  const sounds = h.sounds.length;
  h.input('click'); // Resume without sound
  assert.equal(h.sounds.length, sounds);
  h.send({ type: 'screen', on: false });
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.errors, []);
});
