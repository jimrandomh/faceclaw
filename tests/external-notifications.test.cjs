const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../.test-build/app/native/external-notifications.js");
const A = "test.a/.Service", B = "test.b/.Service";
const now = Date.now();
const message = (fields = {}) => ({ id: "1", target: "opaque-conversation", title: "Synthetic sender", text: "Synthetic text", expiresAt: now + 10000, ...fields });
function reset() { store.setExternalNotificationPolicy(() => true); store.invalidateExternalNotificationReplies(); store.clearExternalNotifications(A); store.clearExternalNotifications(B); }
test("notification keys and deletion are isolated between packages", () => {
 reset(); const first = store.putExternalNotification(A, "A", message(), true, now);
 const second = store.putExternalNotification(B, "B", message(), true, now);
 assert.notEqual(first, second); store.removeExternalNotification(A, "1");
 assert.deepEqual(store.externalNotifications(now).map(x => x.key), [second]); reset();
});
test("expired or revoked content cannot be opened through a stale alert", () => {
 reset(); let opened = false; store.configureExternalNotifications(() => { opened = true; }, () => {});
 const key = store.putExternalNotification(A, "A", message({ expiresAt: now + 1 }), true, now);
 store.externalNotifications(now + 2); assert.equal(store.invokeExternalNotification(key, 0), false); assert.equal(opened, false);
 const revoked = store.putExternalNotification(A, "A", message(), true, now); store.clearExternalNotifications(A);
 assert.equal(store.invokeExternalNotification(revoked, 0), false); assert.equal(opened, false); reset();
});
test("sender-only mode does not retain message body in the notification cache", () => {
 reset(); store.putExternalNotification(A, "A", message(), false, now);
 assert.equal(JSON.stringify(store.externalNotifications(now)).includes("Synthetic text"), false); reset();
});
test("notification memory and hostile text sizes are bounded", () => {
 reset(); assert.equal(store.putExternalNotification(A, "A", message({ text: "x".repeat(4097) }), true, now), null);
 assert.equal(store.putExternalNotification(A, "A", message({ target: "" }), true, now), null);
 for (let i = 0; i < 32; i++) assert.ok(store.putExternalNotification(A, "A", message({ id: String(i) }), true, now));
 assert.equal(store.putExternalNotification(A, "A", message({ id: "over-budget" }), true, now), null);
 assert.ok(store.putExternalNotification(A, "A", message({ id: "1" }), true, now)); reset();
});
test("retention never exceeds 30 days and source filtering is reversible", () => {
 reset(); store.putExternalNotification(A, "A", message({ expiresAt: now + 90 * 86400000 }), true, now);
 assert.equal(store.externalNotifications(now)[0].expiresAt, now + 30 * 86400000);
 store.setSuppressedNotificationPackages(["official.synthetic"]); assert.equal(store.isNotificationPackageSuppressed("official.synthetic"), true);
 assert.equal(store.isNotificationPackageSuppressed("unrelated.synthetic"), false);
 store.setSuppressedNotificationPackages([]); assert.equal(store.isNotificationPackageSuppressed("official.synthetic"), false); reset();
});

function replyFixture(fields = {}) {
 reset(); const sent = [], results = []; let permitted = true;
 store.configureExternalNotificationReplies(() => permitted, (component, data) => { sent.push([component, data]); return true; });
 const key = store.putExternalNotification(A, 'A', message({ replyToken: 'unique-token', ...fields }), true);
 const version = store.externalNotifications()[0].postTime;
 return { key, version, sent, results, reply: store.getExternalNotificationReply(key, version), deny: () => { permitted = false; } };
}
test('APK review sends exact text once to its own token and never retries uncertain dispatch', () => {
 const h = replyFixture(); assert.ok(h.reply); assert.equal(h.reply.send(''), false); assert.equal(h.reply.send('x'.repeat(8001)), false);
 assert.equal(h.reply.send(' Exact reviewed text ', status => h.results.push(status)), true);
 assert.equal(h.reply.send('again'), false); assert.deepEqual(h.sent, [[A, { id: '1', target: 'opaque-conversation', replyToken: 'unique-token', text: ' Exact reviewed text ', confirmed: true }]]);
 store.acceptExternalNotificationReplyResult(B, { id: '1', replyToken: 'unique-token', status: 'sent' });
 store.acceptExternalNotificationReplyResult(A, { id: '1', replyToken: 'wrong', status: 'sent' });
 store.acceptExternalNotificationReplyResult(A, { id: '1', replyToken: 'unique-token', status: 'untrusted server error' });
 assert.deepEqual(h.results, []);
 store.acceptExternalNotificationReplyResult(A, { id: '1', replyToken: 'unique-token', status: 'draft-saved' });
 store.acceptExternalNotificationReplyResult(A, { id: '1', replyToken: 'unique-token', status: 'sent' });
 assert.deepEqual(h.results, ['draft-saved']); reset();
});
test('APK replies reject replacement, expiry, revoke, dismissal and policy toggle races', () => {
 for (const change of [h => store.putExternalNotification(A, 'A', message({ replyToken: 'new', target: 'changed' }), true),
  h => store.externalNotifications(now + 10001), h => store.clearExternalNotifications(A), h => store.dismissExternalNotification(h.key, h.version),
  h => h.deny(), h => store.invalidateExternalNotificationReplies()]) {
  const h = replyFixture(); change(h); assert.equal(h.reply.isCurrent(), false); assert.equal(h.reply.send('Reviewed'), false); assert.deepEqual(h.sent, []);
 }
 reset();
});
test('identical repost preserves version and consumption; changed version cannot be dismissed by stale callback', () => {
 const h = replyFixture(); h.reply.send('Reviewed');
 store.putExternalNotification(A, 'A', message({ replyToken: 'unique-token' }), true);
 assert.equal(store.externalNotifications()[0].postTime, h.version); assert.equal(store.getExternalNotificationReply(h.key, h.version), undefined);
 store.putExternalNotification(A, 'A', message({ replyToken: 'replacement', text: 'New message' }), true);
 assert.equal(store.dismissExternalNotification(h.key, h.version), false); assert.equal(store.externalNotifications().length, 1); reset();
});
test('muting keeps bounded cache, unmuting restores it silently, and app removal works while muted', () => {
 const h = replyFixture(); let changes = 0; store.configureExternalNotifications(() => {}, () => changes++);
 store.setExternalNotificationPolicy(() => false); assert.equal(store.externalNotifications().length, 0); assert.equal(h.reply.isCurrent(), false);
 store.putExternalNotification(B, 'B', message(), true); assert.equal(store.externalNotifications().length, 0);
 store.setExternalNotificationPolicy(() => true); assert.equal(store.externalNotifications().length, 2); assert.equal(changes, 0);
 store.setExternalNotificationPolicy(() => false); store.removeExternalNotification(A, '1');
 store.setExternalNotificationPolicy(() => true); assert.equal(store.externalNotifications().length, 1); assert.equal(store.externalNotifications()[0].component, B); reset();
});
test('reply timeout and invalidation settle once without accepting delayed acknowledgements', () => {
 for (const status of ['unknown', 'rejected']) {
  const h = replyFixture({ expiresAt: now + 100000 }); h.reply.send('Reviewed', result => h.results.push(result));
  if (status === 'unknown') store.externalNotifications(Date.now() + 20001); else store.clearExternalNotifications(A);
  store.acceptExternalNotificationReplyResult(A, { id: '1', replyToken: 'unique-token', status: 'sent' });
  assert.deepEqual(h.results, [status]);
 }
 reset();
});
