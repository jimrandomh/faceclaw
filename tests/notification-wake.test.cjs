const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function harness() {
  const source = ts.createSourceFile('controller.ts', fs.readFileSync('app/g2/dashboard-controller.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const wanted = new Set(['renderShell', 'ensureEvenHubSessionActive']);
  let methods;
  function visit(node) { if (ts.isClassDeclaration(node)) { const found = node.members.filter(m => wanted.has(m.name?.getText(source))); if (found.length === 2) methods = found.map(m => m.getText(source)); } ts.forEachChild(node, visit); }
  visit(source);
  const events = []; let submit;
  const context = {
    shell: { isScreenOn: () => true, describeInputTarget() {}, paintSurface: () => [], underlayDim: () => 256 },
    frameTimings: { startFrame: () => 1, annotateFrame() {}, span: (_id, _label, fn) => fn(), runWithFrame: (_id, fn) => fn(), spanAsync: (_id, _label, fn) => fn(), finishFrame() {}, logFrame() {} },
    beginRenderPass() {}, endRenderPass: () => false, planesFingerprint: () => 'frame',
    flattenPlanesWithDraws: () => ({ image: { width: 640, height: 350, to8bppBuffer: () => [] }, draws: [] }),
    prepareFrameDraws: () => [], SHELL_SURFACE_ID: 'shell', SHELL_SURFACE_Z_ORDER: 100,
    FRAME_TRANSMIT_BACKPRESSURE_TIMEOUT_MS: 1, EVENHUB_WAKE_READY_TIMEOUT_MS: 1,
  };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(`class Harness { ${methods.join('\n')} }; globalThis.Harness = Harness;`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
  const controller = new context.Harness();
  Object.assign(controller, { pendingNotificationWake: { readyForDisplay: false }, phase: 'connected', appliedUnderlayDim: 256,
    schedulePreviewUpdate() {}, display: { submitSurfaceFrame: async () => { events.push('submit'); if (submit) await submit(); }, waitForFrameFinished: async () => { events.push('wait'); return true; } },
    communicator: { setG2ScreenOn: async () => events.push('screen-on'), resumeEvenHubSession: async () => { events.push('resume'); return true; }, setScreenBlanked: async () => events.push('unblank'), awaitEvenHubSessionReady: async () => true },
  });
  return { controller, events, onSubmit: fn => submit = fn };
}
test('notification wake stays blank until content is submitted, without waiting for a blank frame ACK', async () => {
  const h = harness();
  assert.equal(await h.controller.ensureEvenHubSessionActive(), false);
  await h.controller.renderShell(); assert.deepEqual(h.events, ['submit']);
  h.controller.pendingNotificationWake.readyForDisplay = true;
  await h.controller.renderShell();
  assert.deepEqual(h.events, ['submit', 'submit', 'screen-on', 'resume', 'unblank', 'wait']);
  assert.equal(h.controller.pendingNotificationWake, null);
});
test('a replaced notification cannot unblank from the previous in-flight submission', async () => {
  const h = harness(); h.controller.pendingNotificationWake.readyForDisplay = true;
  const replacement = { readyForDisplay: false };
  h.onSubmit(() => { h.controller.pendingNotificationWake = replacement; });
  await h.controller.renderShell();
  assert.deepEqual(h.events, ['submit']); assert.equal(h.controller.pendingNotificationWake, replacement);
});
