const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function harness(deadline = 2500) {
  let now = 0, nextTimer = 0;
  const timers = new Map();
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    Date: { now: () => now },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/apps/external/surface-health.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  const expired = [], changes = [];
  const health = new module.exports.SurfaceHealth(feature => expired.push(feature), () => changes.push('changed'), deadline);
  return {
    health, expired, changes,
    advance(ms) { now += ms; },
    pending() { return [...timers.values()]; },
    expire() { const current = [...timers.values()]; timers.clear(); current.forEach(timer => timer.fn()); },
  };
}

test('first-frame deadline accumulates only while visible and awake', () => {
  const h = harness(2500);
  assert.equal(h.health.open('ui.launcher', 'A:1'), true);
  h.health.visible('ui.launcher', true);
  assert.equal(h.pending()[0].ms, 2500);
  h.advance(1000); h.health.visible('ui.launcher', false);
  assert.equal(h.pending().length, 0);
  h.advance(5000); h.health.visible('ui.launcher', true);
  assert.equal(h.pending()[0].ms, 1500);
  h.advance(1499); assert.equal(h.health.failed('ui.launcher'), false);
  h.advance(1); h.expire();
  assert.deepEqual(h.expired, ['ui.launcher']);
  assert.equal(h.health.failed('ui.launcher'), true);
});

test('healthy streams take over once and reopening the same key waits again', () => {
  const h = harness();
  assert.equal(h.health.open('ui.launcher', 'A:1'), true);
  h.health.visible('ui.launcher', true);
  assert.equal(h.health.frame('ui.launcher'), true);
  assert.equal(h.health.ready('ui.launcher'), true);
  assert.equal(h.health.frame('ui.launcher'), true);
  assert.equal(h.changes.length, 1);

  assert.equal(h.health.open('ui.launcher', 'A:1'), true);
  assert.equal(h.health.ready('ui.launcher'), false);
  h.health.visible('ui.launcher', true);
  h.expire();
  assert.equal(h.health.frame('ui.launcher'), false);
});

test('failure rejects late frames and stays quarantined until reset', () => {
  const h = harness(1);
  h.health.open('ui.notifications', 'A:1');
  h.health.visible('ui.notifications', true);
  h.expire();
  assert.equal(h.health.frame('ui.notifications'), false);
  assert.equal(h.health.open('ui.notifications', 'A:1'), false);
  h.health.close('ui.notifications');
  assert.equal(h.health.open('ui.notifications', 'A:1'), true);
});
