const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(path, imports = {}) {
 const module = { exports: {} };
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText,
  { module, exports: module.exports, require: name => { assert.ok(name in imports, name); return imports[name]; } });
 return module.exports;
}
function setup() {
 const store = load('app/native/external-notifications.ts'), sent = [], reviews = []; let focused = 'notes', on = true;
 store.configureExternalNotificationReplies(() => on, (...args) => { sent.push(args); return true; });
 const key = store.putExternalNotification('fixture.app/.Service', 'Fixture', { id: '1', target: 'target', title: 'Sender', text: 'Message', expiresAt: Date.now() + 60000, replyToken: 'token' }, true);
 const imports = {};
 for (const node of ts.createSourceFile('source', fs.readFileSync('app/ui/notifications.ts', 'utf8'), ts.ScriptTarget.Latest).statements)
  if (ts.isImportDeclaration(node)) imports[node.moduleSpecifier.text] = {};
 imports['../native/external-notifications'] = store;
 imports['~/util/numeric-util'] = load('app/util/numeric-util.ts');
 imports['./notification-routing'] = { routeNotificationOpen: () => false };
 imports['./shell/shell'] = { shell: { foregroundWindow: () => ({ windowId: focused }), isScreenOn: () => on, openReviewedVoiceInput: (...args) => reviews.push(args) } };
 imports['../native/notification-icons'] = { readActiveNotifications: (_max, includeExternal) => includeExternal ? store.externalNotifications() : [], replyToNotification: () => assert.fail('APK text reached RemoteInput'), invokeNotificationAction: () => assert.fail('APK reply reached native action') };
 const { SingleNotificationLayer } = load('app/ui/notifications.ts', imports);
 const layer = new SingleNotificationLayer(key, { origin: 'notifications-list' }), ctx = { stack: { pop() {} }, actions: { requestRender() {} } };
 layer.handleInput({ type: 'scroll-down' }, ctx); layer.handleInput({ type: 'scroll-down' }, ctx); layer.handleInput({ type: 'click' }, ctx);
 return { store, sent, reviews, layer, key, focus: () => { focused = 'other'; }, sleep: () => { on = false; } };
}
test('stock reader uses exact APK review and safe acknowledgement instead of RemoteInput', () => {
 const h = setup(); assert.equal(h.reviews.length, 1); assert.deepEqual(h.sent, []); assert.equal(h.reviews[0][1](), true);
 h.reviews[0][0].onSend('Exact reviewed text'); assert.equal(h.sent.length, 1); assert.equal(h.sent[0][1].text, 'Exact reviewed text'); assert.equal(h.layer.actionError, 'Reply submitted to app.');
 h.store.acceptExternalNotificationReplyResult('fixture.app/.Service', { id: '1', replyToken: 'token', status: 'unknown' }); assert.match(h.layer.actionError, /outcome unknown/);
 h.reviews[0][0].onSend('Again'); assert.equal(h.sent.length, 1);
});
test('stock reader refuses stale review after removal, expiry, navigation or sleep', () => {
 for (const change of [h => h.layer.onRemoved(), h => h.focus(), h => h.sleep(), h => h.store.removeExternalNotification('fixture.app/.Service', '1'), h => h.store.externalNotifications(Date.now() + 60001)]) {
  const h = setup(); change(h); assert.equal(h.reviews[0][1](), false); h.reviews[0][0].onSend('Reviewed'); assert.deepEqual(h.sent, []);
 }
});
