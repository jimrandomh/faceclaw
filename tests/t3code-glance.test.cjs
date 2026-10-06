const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGlanceSnapshot, glanceSummary } = require('../.test-build/app/apps/t3code/t3-glance.js');
const { threadMarker } = require('../.test-build/app/apps/t3code/t3-model.js');

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function thread(id, extra = {}) {
  return {
    id, projectId: 'p1', title: `Thread ${id}`, status: 'completed', latestRunId: 'r', activeProviderThreadId: 'x',
    pendingBackgroundTasks: [], latestUserMessageAt: iso(-60_000), updatedAt: iso(-60_000), createdAt: iso(-86_400_000),
    lineage: {}, ...extra,
  };
}

const env = (id, threads, extra = {}) => ({ id, ready: true, phase: 'connected', enabled: true, threads, ...extra });

test('rows: needs-you, then working, then recent, across environments; settled and snoozed left out', () => {
  const snapshot = buildGlanceSnapshot([
    env('a', [
      thread('recent', { latestUserMessageAt: iso(-120_000) }),
      thread('approve', { status: 'running', pendingRuntimeRequest: { id: 'q1', kind: 'file-change', createdAt: iso(-1000) } }),
      thread('done', { settledOverride: 'settled', settledAt: iso(-1000) }),
    ]),
    env('b', [
      thread('busy', { status: 'running', latestUserAuthoredMessageAt: iso(-30_000) }),
      thread('nap', { snoozedUntil: iso(3_600_000), snoozedAt: iso(-1000) }),
      thread('new', { latestRunCompletedAt: iso(-5000), lastVisitedAt: iso(-50_000), latestUserMessageAt: iso(-10_000) }),
    ]),
  ], NOW);
  assert.deepEqual(snapshot.rows.map((row) => row.key), ['a:approve', 'b:busy', 'b:new', 'a:recent']);
  assert.deepEqual(snapshot.rows.map((row) => row.status), ['approval', 'working', 'ready', 'ready']);
  assert.equal(snapshot.rows[0].requestKind, 'file-change');
  assert.equal(snapshot.rows[2].unread, true);
  assert.equal(snapshot.needsYou, 1);
  assert.equal(snapshot.working, 1);
  assert.equal(snapshot.more, 0);
  assert.equal(snapshot.status, '');
  assert.equal(glanceSummary(snapshot), '1 needs you · 1 working');
  // It crosses postMessage: plain JSON only.
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test('caps rows and counts the rest', () => {
  const threads = Array.from({ length: 30 }, (_, index) => thread(`t${index}`, { latestUserMessageAt: iso(-index * 1000) }));
  const snapshot = buildGlanceSnapshot([env('a', threads)], NOW);
  assert.equal(snapshot.rows.length, 24);
  assert.equal(snapshot.more, 6);
});

test('status when nothing is connected', () => {
  assert.deepEqual(buildGlanceSnapshot([], NOW), { configured: false, status: '', needsYou: 0, working: 0, rows: [], more: 0 });
  const status = (environments) => buildGlanceSnapshot(environments, NOW).status;
  assert.equal(status([env('a', [], { ready: false, phase: 'connecting' })]), 'Connecting…');
  assert.equal(status([env('a', [], { ready: false, phase: 'retrying' })]), "Can't reach T3 Code");
  assert.equal(status([env('a', [], { ready: false, phase: 'auth-failed' })]), 'Pair again in the T3 Code app');
  assert.equal(status([env('a', [], { ready: false, phase: 'idle', enabled: false })]), 'Disconnected');
  // One connected environment is enough to show threads.
  assert.equal(status([env('a', [], { ready: false, phase: 'retrying' }), env('b', [])]), '');
});

test('status marks', () => {
  assert.deepEqual(threadMarker('approval'), { marker: '!', value: 255 });
  assert.deepEqual(threadMarker('input'), { marker: '?', value: 255 });
  assert.equal(threadMarker('working').marker, '…');
  assert.equal(threadMarker('ready', { unread: true }).marker, '●');
  assert.equal(threadMarker('ready', { settled: true, unread: true }).marker, '✓');
  assert.equal(threadMarker('ready').marker, '');
  assert.equal(threadMarker('failed', { unread: true }).marker, 'x');
});
