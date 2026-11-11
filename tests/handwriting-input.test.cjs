const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const context = { exports: {}, require: (name) => modules[name] ?? {}, console, Intl };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context, { filename: file });
  return context.exports;
}

/** A stand-in for the dialog menu: rows plus a highlight that scrolls. */
function fakeMenu(rows, selected) {
  return {
    rows, selected,
    setItems(next) { this.rows = next; },
    get selectedItem() { return this.rows[this.selected]; },
    async handleInput(event) {
      if (event.type === 'scroll-down') this.selected = Math.min(this.rows.length - 1, this.selected + 1);
      if (event.type === 'scroll-up') this.selected = Math.max(0, this.selected - 1);
      return true;
    },
  };
}

const painted = [];
const { HandwritingInputLayer, dropLastCharacter } = load('app/ui/shell/handwriting-input.ts', {
  './input-dialog': {
    createInputDialogMenu: fakeMenu,
    paintInputDialog: (_image, content) => painted.push(content),
  },
});

function fixture({ startProblem = null, defaultTargetIndex = 1 } = {}) {
  const log = [];
  let listener = null;
  const source = {
    name: 'Neural Band',
    start(l) { log.push('start'); listener = l; return startProblem; },
    setText(text) { log.push(`setText:${JSON.stringify(text)}`); },
    stop() { log.push('stop'); },
  };
  const sent = [];
  const layer = new HandwritingInputLayer({
    actions: { requestRender: () => {} },
    source,
    onClosed: () => log.push('closed'),
    dismiss: () => { log.push('dismiss'); layer.onRemoved(); },
    sendTargets: [
      { id: 'assistant', label: 'Send to Assistant', onSend: (text) => sent.push(['assistant', text]) },
      { id: 'app', label: 'Type Into App', onSend: (text) => sent.push(['app', text]) },
    ],
    defaultTargetIndex,
  });
  const input = (type) => layer.handleInput({ type, timestampMs: 0, source: 'watch' }, {});
  const status = () => { painted.length = 0; layer.paint({}, () => ({})); return painted[0]; };
  return { layer, log, sent, input, status, write: (text) => listener.text(text), phase: (p, m) => listener.phase(p, m) };
}

test('the dialog starts the source, follows its phase and shows what is written', () => {
  const h = fixture();
  assert.deepEqual(h.log, ['start']);
  assert.match(h.status().status, /Starting the Neural Band/);
  h.phase('ready', '');
  assert.equal(h.status().status, 'Write with your index finger');
  h.write('hel');
  h.write('hello');
  assert.equal(h.status().text, 'hello');
  h.phase('stopped', 'Handwriting stopped: the band model stopped sending samples');
  assert.match(h.status().status, /stopped sending samples/);
});

test('a tap sends the trimmed text to the highlighted target and stops the source', () => {
  const h = fixture();
  h.write('  ls -la \n');
  h.input('click');
  assert.deepEqual(h.sent, [['app', 'ls -la']]);
  assert.deepEqual(h.log, ['start', 'dismiss', 'stop', 'closed']);
  // Further input after closing does nothing.
  h.input('click');
  assert.equal(h.sent.length, 1);
});

test('nothing is sent while nothing is written', () => {
  const h = fixture();
  h.input('click');
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.log, ['start']);
});

test('swipes edit: left erases a character, right adds one space; up and down move the menu', () => {
  const h = fixture();
  h.write('hi 👋🏽');
  h.input('swipe-left');
  assert.equal(h.status().text, 'hi ');
  h.input('swipe-right');
  assert.equal(h.status().text, 'hi ');
  h.input('swipe-left');
  h.input('swipe-right');
  assert.equal(h.status().text, 'hi ');
  assert.deepEqual(h.log.filter((entry) => entry.startsWith('setText')), ['setText:"hi "', 'setText:"hi"', 'setText:"hi "']);
  h.input('swipe-up');
  h.input('click');
  assert.deepEqual(h.sent, [['assistant', 'hi']]);
});

test('a double tap discards; the screen going off ends the session too', () => {
  const h = fixture();
  h.write('draft');
  h.input('double-click');
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.log, ['start', 'dismiss', 'stop', 'closed']);
  const off = fixture();
  off.layer.onRemoved();
  assert.deepEqual(off.log, ['start', 'stop', 'closed']);
});

test('a source that cannot start says why', () => {
  const h = fixture({ startProblem: 'Connect the Neural Band first.' });
  assert.equal(h.status().status, 'Connect the Neural Band first.');
});

test('erasing drops whole characters', () => {
  assert.equal(dropLastCharacter('ab'), 'a');
  assert.equal(dropLastCharacter('é'), '');
  assert.equal(dropLastCharacter('👍🏽'), '');
  assert.equal(dropLastCharacter(''), '');
});
