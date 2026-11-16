const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, dependencies) {
  const context = { exports: {}, console, require: (name) => {
    assert.ok(name in dependencies, name);
    return dependencies[name];
  } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}

const installedApps = {
  getInstalledEvenHubApps: () => [],
  getInstalledEvenHubFingerprint: () => '',
  installedEvenHubAppId: (packageId) => packageId,
  renderInstalledEvenHubIcon: () => null,
};

test('the launcher grid leaves out an app the paired glasses cannot run', () => {
  const { launcherEntries } = load('app/apps/launcher/index.ts', {
    '../../ui/shell/shell': { shell: {} },
    './launcher-app': {},
    '../evenhub/installed-apps': installedApps,
  });
  let supported = true;
  const apps = [
    { appId: 'launcher', title: 'Apps', showInLauncher: false },
    { appId: 'timer', title: 'Timer' },
    { appId: 'compass', title: 'Compass', isSupported: () => supported },
  ];
  const ids = () => Array.from(launcherEntries(apps), (entry) => entry.appId);
  assert.deepEqual(ids(), ['timer', 'compass']);
  supported = false;
  assert.deepEqual(ids(), ['timer']);
});

test('apps.launch follows the paired glasses', async () => {
  const listeners = [];
  const { registerWindowTools } = load('app/assistant/window-tools.ts', {
    '../ui/shell/shell': { shell: { wake() {} } },
    '../apps/launcher/launcher-folders': {},
    '../apps/evenhub/installed-apps': installedApps,
    '../ui/dashboard-settings': { onAnySettingChanged: (listener) => listeners.push(listener) },
    './tool-registry': { toolRegistry: null },
  });
  const tools = new Map();
  const registry = { registerSystemTool: (spec, handler) => tools.set(spec.name, { spec, handler }) };
  const launched = [];
  const timer = { appId: 'timer', title: 'Timer' };
  const compass = { appId: 'compass', title: 'Compass' };
  let apps = [timer, compass];
  registerWindowTools({ apps: () => apps, launchApp: (appId) => launched.push(appId), requestShellRender() {} }, registry);
  const launch = () => tools.get('apps.launch');
  const launchIds = () => Array.from(launch().spec.inputSchema.properties.app_id.enum);
  assert.deepEqual(launchIds(), ['compass', 'timer']);

  apps = [timer];
  listeners.forEach((listener) => listener());
  assert.deepEqual(launchIds(), ['timer']);
  await launch().handler({ app_id: 'compass' });
  assert.deepEqual(launched, []);
  await launch().handler({ app_id: 'timer' });
  assert.deepEqual(launched, ['timer']);
});
