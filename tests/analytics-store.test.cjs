const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const START = Date.parse('2026-10-10T12:00:00Z');

/** analytics-store.ts over in-memory files, a settable clock and setting, and a fake server. */
function harness({ level = 'minimal', version = '0.8.3', statuses = [] } = {}) {
  const files = new Map();
  const sent = [];
  const h = {
    files, sent, level, version, now: START, statuses: [...statuses],
    pendingSend: null,
    snapshots: { minimal: { 'device.g2.paired': true }, full: { 'apikey.anthropic': true } },
  };
  let nextId = 1;
  const { AnalyticsStore } = loader({
    setTimeout: () => 0,
    clearTimeout: () => {},
  })('app/analytics/analytics-store.ts');
  h.store = new AnalyticsStore({
    storage: {
      read: name => files.get(name) ?? null,
      write: (name, text) => files.set(name, text),
      remove: name => files.delete(name),
      list: () => [...files.keys()],
      removeAll: () => files.clear(),
    },
    level: () => h.level,
    appInfo: () => ({ version: h.version, platform: 'android', build: 'official' }),
    now: () => h.now,
    randomId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
    snapshot: level => ({ ...h.snapshots[level] }),
    send: async body => {
      sent.push(JSON.parse(body));
      if (h.pendingSend) await h.pendingSend;
      const status = h.statuses.length ? h.statuses.shift() : 200;
      if (status === 'network') throw new Error('offline');
      return status;
    },
  });
  h.outbox = () => [...files.keys()].filter(name => name.startsWith('outbox-'));
  h.state = () => JSON.parse(files.get('state.json'));
  return h;
}

test('Analytics keeps only what the data-collection setting allows', () => {
  const h = harness({ level: 'minimal' });
  h.store.count('minimal', 'g2.connect');
  h.store.count('full', 'app.launch.timer');
  h.store.flush();
  const pending = JSON.parse(h.files.get('pending.json'));
  assert.deepEqual(pending.counters.minimal, { '2026-10-10': { 'g2.connect': 1 } });
  assert.deepEqual(pending.counters.full, {});

  const off = harness({ level: 'none' });
  off.store.count('minimal', 'g2.connect');
  off.store.flush();
  off.store.applyLevel();
  assert.equal(off.files.size, 0);
});

test('Analytics drops bad counter names and flags count once a day', () => {
  const h = harness();
  h.store.count('minimal', 'Bad Name');
  h.store.flag('minimal', 'device.r1.used');
  h.store.flag('minimal', 'device.r1.used');
  h.store.count('minimal', 'g2.ack-timeout', 3);
  h.store.flush();
  assert.deepEqual(JSON.parse(h.files.get('pending.json')).counters.minimal['2026-10-10'], {
    'device.r1.used': 1, 'g2.ack-timeout': 3,
  });
});

test('Analytics seals and uploads a report once a day', async () => {
  const h = harness({ level: 'full' });
  h.store.count('minimal', 'g2.connect', 2);
  h.store.count('full', 'feature.used');
  await h.store.uploadIfDue();
  assert.equal(h.sent.length, 1);
  const [report] = h.sent;
  assert.equal(report.schema, 1);
  assert.equal(report.level, 'full');
  assert.match(report.installId, /^00000000-/);
  assert.deepEqual(report.app, { version: '0.8.3', platform: 'android', build: 'official' });
  assert.deepEqual(report.counters, { '2026-10-10': { 'g2.connect': 2, 'feature.used': 1 } });
  assert.deepEqual(report.snapshot, { 'device.g2.paired': true, 'apikey.anthropic': true });
  assert.deepEqual(h.outbox(), []);

  h.store.count('minimal', 'g2.connect');
  h.now += 3 * HOUR_MS;
  await h.store.uploadIfDue();
  assert.equal(h.sent.length, 1, 'not due again the same day');

  h.now = START + DAY_MS;
  await h.store.uploadIfDue();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].installId, report.installId);
  assert.notEqual(h.sent[1].reportId, report.reportId);
  assert.deepEqual(h.sent[1].counters, { '2026-10-10': { 'g2.connect': 1 } });
});

test('Analytics retries a failed upload hourly with the same report id, and drops rejected ones', async () => {
  const h = harness({ statuses: ['network', 503] });
  h.store.count('minimal', 'g2.connect');
  await h.store.uploadIfDue();
  assert.equal(h.outbox().length, 1);

  h.now += 30 * 60 * 1000;
  await h.store.uploadIfDue();
  assert.equal(h.sent.length, 1, 'no retry within the hour');

  h.now = START + HOUR_MS;
  await h.store.uploadIfDue();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].reportId, h.sent[0].reportId);
  assert.equal(h.outbox().length, 1, 'kept after a 503');

  h.now = START + 2 * HOUR_MS;
  await h.store.uploadIfDue();
  assert.equal(h.sent.length, 3);
  assert.deepEqual(h.outbox(), []);
  assert.equal(h.state().retryAt, 0);

  const rejected = harness({ statuses: [400] });
  await rejected.store.uploadIfDue();
  assert.deepEqual(rejected.outbox(), [], 'a 400 is not retried');
});

test('Analytics turned off deletes everything, and a new install id is made when it comes back', async () => {
  const h = harness();
  h.store.count('minimal', 'g2.connect');
  await h.store.uploadIfDue();
  const firstInstall = h.sent[0].installId;
  h.store.count('minimal', 'g2.connect');
  h.store.flush();

  h.level = 'none';
  h.store.applyLevel();
  assert.equal(h.files.size, 0);
  await h.store.uploadIfDue();
  assert.equal(h.sent.length, 1, 'no connection while off');

  h.level = 'minimal';
  h.now += DAY_MS;
  await h.store.uploadIfDue();
  assert.equal(h.sent.length, 2);
  assert.notEqual(h.sent[1].installId, firstInstall);
  assert.deepEqual(h.sent[1].counters, {}, 'counts from before turning off are gone');
});

test('Analytics turned down to minimal drops what was kept for full', async () => {
  const h = harness({ level: 'full', statuses: ['network'] });
  h.store.count('minimal', 'g2.connect');
  h.store.count('full', 'feature.used');
  await h.store.uploadIfDue();
  h.store.count('full', 'feature.used');
  h.store.flush();

  h.level = 'minimal';
  h.store.applyLevel();
  assert.deepEqual(JSON.parse(h.files.get('pending.json')).counters.full, {});
  const [outbox] = h.outbox();
  assert.deepEqual(JSON.parse(h.files.get(outbox)).snapshot.full, {});

  h.now += HOUR_MS;
  await h.store.uploadIfDue();
  const retried = h.sent[1];
  assert.equal(retried.level, 'minimal');
  assert.deepEqual(retried.counters, { '2026-10-10': { 'g2.connect': 1 } });
  assert.deepEqual(retried.snapshot, { 'device.g2.paired': true });
});

test('Analytics sends counts from before an upgrade under the old version', async () => {
  const h = harness({ version: '0.8.3' });
  h.store.count('minimal', 'g2.connect');
  h.store.flush();

  // A new process after the upgrade.
  const files = h.files;
  const upgraded = harness({ version: '0.8.4' });
  for (const [name, text] of files) upgraded.files.set(name, text);
  upgraded.store.count('minimal', 'g2.connect', 5);
  await upgraded.store.uploadIfDue();
  assert.deepEqual(upgraded.sent.map(report => [report.app.version, report.counters['2026-10-10']]), [
    ['0.8.3', { 'g2.connect': 1 }],
    ['0.8.4', { 'g2.connect': 5 }],
  ]);
});

test('Analytics turned off and on during an upload keeps none of the old state', async () => {
  const h = harness();
  let release;
  h.pendingSend = new Promise(resolve => { release = resolve; });
  const upload = h.store.uploadIfDue();
  await Promise.resolve();
  h.level = 'none';
  h.store.applyLevel();
  h.level = 'minimal';
  release();
  await upload;
  assert.equal(h.files.size, 0, 'the old install id is not written back');
});
