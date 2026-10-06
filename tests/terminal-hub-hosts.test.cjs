const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Run the worker's actual hub session-list builder with its collaborators stubbed.
function hub({ presets = [] } = {}) {
  const file = 'app/apps/terminal/terminal-app.worker.ts';
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = new Set(['hubSessionItems', 'isControlConnected', 'controlStatusWord', 'orderedSessions', 'recencyKey', 'sessionLabel']);
  const selected = source.statements.filter((s) => ts.isFunctionDeclaration(s) && functions.has(s.name?.text));
  const connected = [];
  const context = {
    controls: new Map(), sessionRecency: new Map(),
    launchPresetNames: () => presets,
    connectionDisplayName: (config) => config.name,
    clientOptionsFor: (config) => (config.url === 'bad' ? null : {}),
    isSessionActive: () => false, viewGlyphForSocket: () => null, viewWindowIdForSocket: () => null,
    connectControl: (control) => connected.push(control.config.name),
  };
  vm.runInNewContext(ts.transpileModule(selected.map((s) => s.getText(source)).join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  const window = { sessionOrder: [] };
  return {
    connected,
    add(name, { enabled = true, phase = null, sessions = [], retrying = false, url = 'ok' } = {}) {
      context.controls.set(name, {
        config: { id: name, name, url, enabled },
        state: phase && { phase, sessions: sessions.map((title) => ({ socket: title, title, command: title })) },
        reconnectTimer: retrying ? 1 : null,
      });
    },
    items: () => context.hubSessionItems(window).slice(2), // past Manage Connections + Settings
  };
}

// Array.from: the items are arrays from the vm realm.
const rows = (items) => Array.from(items, (item) => `${item.heading ? '# ' : ''}${item.label}${item.onSelect ? '' : ' [x]'}`);

test('every configured host gets a heading in stored order, whatever its state', () => {
  const h = hub();
  h.add('alpha', { phase: 'connecting' });
  h.add('beta', { phase: 'connected', sessions: ['vim'] });
  h.add('gamma', { phase: 'failed', retrying: true });
  h.add('delta', { enabled: false });
  h.add('epsilon', { url: 'bad' });
  assert.deepEqual(rows(h.items()), [
    '# alpha  (connecting) [x]',
    '# beta [x]',
    'vim',
    '# gamma  (retrying) [x]',
    'Connect now',
    '# delta  (off) [x]',
    'Connect',
    '# epsilon  (bad connection string) [x]',
  ]);
  h.items().find((item) => item.label === 'Connect').onSelect();
  assert.deepEqual(h.connected, ['delta']);
});

test('a lone host still shows its heading; connected headings launch when presets exist', () => {
  const h = hub({ presets: ['shell'] });
  h.add('solo', { phase: 'connected' });
  assert.deepEqual(rows(h.items()), ['# solo', '(no live sessions; run g2mirror <command>)']);
  const lone = hub();
  lone.add('solo', { phase: 'connecting' });
  assert.deepEqual(rows(lone.items()), ['# solo  (connecting) [x]']);
});
