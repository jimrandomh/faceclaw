const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function harness() {
  let effective = true;
  let ready = false;
  let captured;
  let hostSubmits = 0;
  const platform = { surfaceReady: () => ready, feature: () => ({ component: 'example/Service', generation: 1 }) };
  const modules = {
    '../../ui/shell/extension-launcher': { attachLauncherSurface() {} },
    '../../ui/extension-settings': { effectiveExtension: () => effective ? { component: 'example/Service', generation: 1 } : undefined },
    '../external/extension-platform': { extensionPlatform: () => platform },
    '../../graphics/bdffont': {},
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => ({}) },
    '../../graphics/textwrap': { truncateText: text => text },
    '../../graphics/image': { GrayImage: class {} },
    '../../graphics/plane': {},
    '../../graphics/icons': { renderIcon: () => {} },
    '../../util/numeric-util': { clamp: value => value },
    '../../ui/gestures': {},
    '../../ui/layers': { Layer: class {} },
    '../../ui/menu': { drawSelectionHighlight() {}, MenuLayer: class {}, scrollToKeepSelectionVisible() {} },
    '../../ui/metrics': { iconGridMinRowHeight: () => 40 },
    '../../ui/window-menu': { WINDOW_MENU_LAYOUT: {} },
    '../../ui/dashboard-settings': { onAnySettingChanged() {} },
    '../../ui/shell/in-process-window': { createInProcessWindow: options => { captured = options; return { window: {} }; } },
    './launcher-folders': {
      getFolderAssignments: () => ({}), getFolders: () => [], setAppFolder() {},
      unusedNewFolderName: () => 'Folder', getFolderStateFingerprint: () => '',
    },
    '../../ui/shell/shell': { shell: { registerWindow() {} } },
  };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/apps/launcher/launcher-app.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    module,
    exports: module.exports,
    require: name => { assert.ok(name in modules, name); return modules[name]; },
  });
  module.exports.createLauncherWindow({
    actions: {}, apps: () => [], launchApp() {}, uninstallApp() {},
    submitFrame: () => { hostSubmits++; return Promise.resolve(); },
    setSurfaceVisible() {},
  });
  return {
    submit: () => captured.submitFrame([], 0, 1),
    effective: value => { effective = value; },
    ready: value => { ready = value; },
    hostSubmits: () => hostSubmits,
  };
}

test('launcher submits host pixels while provider is pending or failed, then stops after takeover', async () => {
  const h = harness();
  await h.submit();
  assert.equal(h.hostSubmits(), 1);

  h.ready(true);
  await h.submit();
  assert.equal(h.hostSubmits(), 1);

  h.ready(false); // Timed-out/quarantined provider: host rendering resumes.
  await h.submit();
  assert.equal(h.hostSubmits(), 2);

  h.effective(false);
  await h.submit();
  assert.equal(h.hostSubmits(), 3);
});
