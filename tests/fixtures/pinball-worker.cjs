// Execute the production worker, replacing only NativeScript/platform services.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');

function load(file, modules = {}, extra = '', globals = {}) {
  const context = { exports: {}, console, ...globals, require: (name) => {
    if (!(name in modules)) throw new Error(`Unexpected dependency: ${name}`);
    return modules[name];
  } };
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText + extra, context, { filename: file });
  return context.exports;
}

const { BdfFont } = load('app/graphics/bdffont.ts', { '@nativescript/core': {} });
const font = (size) => BdfFont.parse(fs.readFileSync(path.join(root, `app/fonts/terminus/ter-u${size}n.bdf`), 'utf8'));
const fonts = { terminus24: font(24), terminus32: font(32) };
const smallFont = font(18);
const graphics = load('app/graphics/image.ts', { './textwrap': load('app/graphics/textwrap.ts') });

module.exports = function worker() {
  let now = 10000;
  let highScore = '0';
  const noop = () => {};
  const global = { postMessage: noop };
  const api = load('app/apps/pinball/pinball-app.worker.ts', {
    '@nativescript/core/globals': {},
    '../../graphics/image': graphics,
    '../../graphics/plane': {}, '../../graphics/glyph-wire': {},
    '../../graphics/bdffont': { getFont: (name) => fonts[name] },
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => smallFont },
    '../../native/frame-timings': { finishFrame: noop, logFrame: noop },
    '../../native/active-display': {},
    '../../native/settings-store': { getStringSetting: () => highScore, setStringSetting: (_, value) => { highScore = value; } },
    '../../ui/sound-effects': {},
    '../../ui/window-menu': { WindowMenu: class { open() {} } },
    '../../ui/gestures': { directionalFallback: (event) => event, GESTURE_CLICK: '●', GESTURE_DOUBLE_CLICK: '●●', GESTURE_SCROLL: '↕', GESTURE_LONG_PRESS: '—' },
    '../../util/numeric-util': { clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)) },
  }, `
    renderAndSubmit = () => {};
    playSfx = () => {};
    exports.api = { windows, launchBall, ballDrained, stepPhysics, tick, flip, nudge,
      checkTargets, checkRollovers, collideBumpers, resetGame, paintContent, TARGETS, ROLLOVERS };
  `, { global, Date: { now: () => now }, setInterval: () => 1, clearInterval: noop }).api;
  const message = (data) => global.onmessage({ data });
  message({ type: 'open-window', windowId: 'test', surfaceId: 'test', title: 'Pinball', viewport: { width: 576, height: 260 } });
  message({ type: 'foreground', windowId: 'test', foreground: true, focused: true });
  const w = api.windows.get('test');
  return { ...api, w, message, highScore: () => Number(highScore),
    input: (type) => message({ type: 'input', windowId: 'test', focused: true, frameId: 1, event: { type } }),
    advance: (seconds) => { for (let i = 0; i < Math.round(seconds * 120); i++) { now += 1000 / 120; api.stepPhysics(w); } },
    elapse: (seconds) => { now += seconds * 1000; },
  };
};
