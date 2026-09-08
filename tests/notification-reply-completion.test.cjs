const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function harness(external = false) {
 const module = { exports: {} }, results = [], dismissed = [], timers = []; let target, isCurrent, nativeAccepted = true, sourcePresent = true, restored = 0, sends = 0, finish;
 const source = { key: external ? 'apk:fixture' : 'fixture', postTime: 7, appName: 'Messages', title: 'Synthetic sender', actions: [{ index: 0, enabled: true, acceptsText: true }] };
 const shell = { isScreenOn: () => true, openReviewedVoiceInput: (next, current) => { target = next; isCurrent = current; return () => {}; } };
 const imports = {
  '../../ui/shell/shell': { shell }, '../../native/notification-icons': { readActiveNotifications: () => sourcePresent ? [source] : [], replyToNotification: () => { sends++; return nativeAccepted; }, dismissNotification: (key, version) => { dismissed.push([key, version]); return true; } },
  '../../native/external-notifications': { getExternalNotificationReply: () => ({ isCurrent: () => sourcePresent, send: (_text, done) => { sends++; finish = done; return true; } }) },
  './extension-policy': { boundedToken: value => typeof value === 'string' },
 };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/apps/external/extension-platform.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
  { module, exports: module.exports, require: name => imports[name] || {}, setTimeout: fn => timers.push(fn) });
 const platform = Object.create(module.exports.ExtensionPlatform.prototype);
 Object.assign(platform, { controls: () => true, isLocked: () => false, event: (_component, _feature, result) => results.push(result), lastGesture: new Map([['ui.notifications', Date.now()]]), reviews: new Map(), uiNotifications: { resolve: () => source }, hooks: { closeSurface(_feature, restoreSleep) { assert.equal(restoreSleep, false); }, notificationReplyReturn: () => () => restored++ } });
 return { results, dismissed, start: () => platform.action('owner', 'ui.notifications', 1, 'notification-review-reply', { callId: 'review', actionIndex: 0 }),
  target: () => target, current: () => isCurrent(), accept: value => nativeAccepted = value, remove: () => sourcePresent = false, sends: () => sends, finish: status => finish(status), flush: () => { while (timers.length) timers.shift()(); }, restored: () => restored };
}
test('confirmed native reply dismisses only its bound version and restores the visit once', async () => {
 const h = harness(); await h.start(); assert.equal(h.target().concealUnderlay, true); assert.equal(h.sends(), 0); assert.deepEqual(h.dismissed, []);
 h.target().onSend('Reviewed fixture'); h.target().onSend('Duplicate'); h.flush();
 assert.equal(h.sends(), 1); assert.deepEqual(h.dismissed, [['fixture', 7]]); assert.equal(h.results[0].status, 'sent'); assert.equal(h.restored(), 1);
});
test('uncertain native send and stale source preserve notifications and never restore the visit', async () => {
 for (const setup of [h => h.accept(false), h => h.remove()]) {
  const h = harness(); await h.start(); setup(h); h.target().onSend('Fixture'); h.flush(); assert.deepEqual(h.dismissed, []); assert.equal(h.restored(), 0);
 }
});
test('external reply completion dismisses on sent only and ignores duplicate acknowledgements', async () => {
 for (const status of ['sent', 'draft-saved', 'unknown', 'rejected']) {
  const h = harness(true); await h.start(); h.target().onSend('Fixture'); assert.deepEqual(h.dismissed, []);
  h.finish(status); h.finish('sent'); h.flush(); assert.equal(h.dismissed.length, status === 'sent' ? 1 : 0); assert.equal(h.restored(), status === 'sent' ? 1 : 0); assert.equal(h.results.length, 1);
 }
});
