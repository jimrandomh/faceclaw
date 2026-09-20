const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const js = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
function load(file, modules = {}) {
  const context = { exports: {}, console, require(name) {
    assert.ok(name in modules, name); return modules[name];
  } };
  vm.runInNewContext(js(read(file)), context);
  return context.exports;
}
const monitor = load('app/ui/input-monitor.ts');
const event = (type, timestampMs = 1000) => ({ type, source: 'ring', timestampMs });

function shellDeclarations() {
  const source = ts.createSourceFile('shell.ts', read('app/ui/shell/shell.ts'), ts.ScriptTarget.Latest, true);
  const names = new Set(['rawInputEventToPayload', 'eventSourceToString', 'scrollEvent']);
  const declarations = source.statements.filter((s) => ts.isFunctionDeclaration(s) && names.has(s.name?.text));
  assert.equal(declarations.length, names.size);
  const shell = source.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === 'Shell');
  const methods = shell.members.filter((s) => ['receiveInput', 'routeInput'].includes(s.name?.getText(source)));
  const context = { exports: {}, notifyInputListeners: monitor.notifyInputListeners,
    ...load('app/g2/events.ts') };
  vm.createContext(context);
  vm.runInContext(js(declarations.map((s) => s.getText(source)).join('\n') +
    '\nexport class Shell {\n' + methods.map((s) => s.getText(source)).join('\n') + '\n}'), context);
  return context;
}

test('new SysEvent decodes independently of click, double-tap, hold and release', () => {
  const d = shellDeclarations();
  for (const source of [0, 2]) {
    const decoded = d.rawInputEventToPayload({ kind: 'sys-event', eventType: 14, eventSource: source });
    assert.equal(decoded.type, 'ring-press'); assert.equal(decoded.source, 'ring');
  }
  for (const source of [1, 3, 99, undefined]) {
    assert.equal(d.rawInputEventToPayload({ kind: 'sys-event', eventType: 14, eventSource: source }).type, 'unknown');
  }
  for (const [id, type] of [[0,'click'],[3,'double-click'],[9,'long-press'],[10,'long-press-release'],[11,'short-then-long-press']]) {
    assert.equal(d.rawInputEventToPayload({ kind: 'sys-event', eventType: id, eventSource: 2 }).type, type);
  }
});

test('press is observed before routing and does not wake, operate shell menus or replace hold state', async () => {
  const { exports: { Shell } } = shellDeclarations();
  for (const screenOn of [true, false]) for (const focus of ['window', 'sidebar']) for (const atBase of [true, false]) {
    const s = new Shell(), seen = [], delivered = [];
    const unsubscribe = monitor.addInputListener((e) => seen.push(e));
    Object.assign(s, { screenOn, focus, stack: { isAtBase: () => atBase },
      foregroundWindow: () => ({ handleInput(e) { assert.equal(seen.length, 1); delivered.push(e); } }),
      syncInputFocus() {}, lastInput: event('long-press'), lastInputAtMs: 123 });
    try {
      const result = await s.receiveInput(event('ring-press'));
      assert.equal(result.shell, false);
      assert.equal(delivered.length, Number(screenOn && focus === 'window' && atBase));
      assert.equal(seen.length, 1);
      assert.equal(s.lastInput.type, 'long-press'); assert.equal(s.lastInputAtMs, 123);
    } finally { unsubscribe(); }
  }
});

test('bounded history preserves equal-time events, snapshots and arrival gaps; pause and clear work', () => {
  const log = new monitor.InputEventLog();
  const first = event('ring-press'); log.add(first); first.type = 'unknown';
  log.add(event('click')); log.add(event('double-click', 1250));
  assert.equal(log.entries[2].event.type, 'ring-press');
  assert.equal(log.entries[2].gapMs, null); assert.equal(log.entries[1].gapMs, 0);
  assert.equal(log.entries[0].gapMs, 250);
  log.paused = true; log.add(event('click')); assert.equal(log.count, 3);
  log.paused = false;
  for (let i = 0; i < 210; i++) log.add(event('click', 2000 + i));
  assert.equal(log.entries.length, 200); assert.equal(log.count, 213);
  log.clear(); log.add(event('ring-press')); assert.equal(log.count, 1); assert.equal(log.entries[0].gapMs, null);
  assert.equal(monitor.inputTimestamp(new Date(2026, 0, 2, 3, 4, 5, 6).getTime()), '03:04:05.006');
});

test('Input events captures while visible, pauses for history, and unsubscribes on removal', () => {
  const textwrap = load('app/graphics/textwrap.ts');
  const graphics = load('app/graphics/image.ts', { './textwrap': textwrap });
  const { BdfFont } = load('app/graphics/bdffont.ts', { '@nativescript/core': {} });
  const font = BdfFont.parse(read('app/fonts/terminus/ter-u18n.bdf'));
  class RecordingImage extends graphics.GrayImage {
    texts = [];
    drawText(font, x, y, text, value) {
      this.texts.push({ x, y, text, width: font.measureText(text), height: font.lineHeight });
      super.drawText(font, x, y, text, value);
    }
  }
  const { InputEventsLayer } = load('app/apps/developer/input-events.ts', {
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../../graphics/image': { GrayImage: RecordingImage }, '../../graphics/textwrap': textwrap,
    '../../ui/input-monitor': monitor, '../../ui/menu': { drawListScrollbar() {} },
  });
  let visible = true, renders = 0, removed = 0, pops = 0;
  const layer = new InputEventsLayer(() => renders++, () => visible, () => removed++);
  const ctx = { stack: { getBaseSize: () => ({ width: 576, height: 260 }),
    pop: () => pops++, popThrough: (page) => { assert.equal(page, layer); page.onRemoved(); } } };
  try {
    for (const type of ['ring-press','click','ring-press','ring-press','double-click','long-press','long-press-release','short-then-long-press']) {
      const e = event(type, 1000 + renders * 75); monitor.notifyInputListeners(e); layer.handleInput(e);
    }
    assert.equal(renders, 8); assert.equal(layer.log.count, 8); assert.equal(pops, 0);
    visible = false; monitor.notifyInputListeners(event('click')); assert.equal(renders, 8); visible = true;
    const image = layer.paint(ctx);
    for (const text of image.texts) {
      assert.ok(text.x >= 0 && text.x + text.width <= image.width, text.text);
      assert.ok(text.y >= 0 && text.y + text.height <= image.height, text.text);
    }
    if (process.env.INPUT_EVENTS_PREVIEW) fs.writeFileSync(process.env.INPUT_EVENTS_PREVIEW, Buffer.concat([
      Buffer.from(`P5\n${image.width} ${image.height}\n255\n`), Buffer.from(image.withDrawsBaked().pixels),
    ]));
    layer.menuItems()[0].onSelect(ctx); monitor.notifyInputListeners(event('click'));
    assert.equal(layer.log.count, 8); assert.equal(layer.menuItems()[0].label, 'Resume capture');
    layer.menuItems()[1].onSelect(ctx); assert.equal(layer.log.count, 0);
    layer.menuItems()[0].onSelect(ctx); monitor.notifyInputListeners(event('ring-press'));
    assert.equal(layer.log.count, 1);
    layer.menuItems()[2].onSelect(ctx); monitor.notifyInputListeners(event('click'));
    assert.equal(removed, 1); assert.equal(layer.log.count, 1);
  } finally { layer.onRemoved(); }
});
