const test = require('node:test');
const assert = require('node:assert/strict');
const { JavaCallQueue, MAX_MERGED_COMPOSITES } = require('../.test-build/app/native/java-call-queue.js');

/** A queue whose compositor calls record "name" when they composite and "(name)" when they merge. */
function recorder() {
  const log = [];
  const queue = new JavaCallQueue(() => log.push('flush'));
  const call = (name, inline = false, fail = false) => queue.enqueueCompositorCall((merge) => {
    log.push(merge ? `(${name})` : name);
    if (fail) throw new Error(name);
  }, inline);
  return { log, queue, call };
}

test('compositor calls queued together composite once, in the last of them', async () => {
  const { log, queue, call } = recorder();
  // A window switch: none of these is awaited before the next is made.
  const calls = [call('hide'), call('show'), call('window', true), call('shell', true)];
  assert.deepEqual(log, [], 'queued behind the first, even the calls that run inline when idle');
  await Promise.all(calls);
  assert.deepEqual(log, ['(hide)', '(show)', '(window)', 'shell']);

  // Awaited one at a time, each composites; so does a call with only other kinds of call behind it.
  log.length = 0;
  await call('hide');
  await call('show');
  const alone = call('blank');
  const other = queue.enqueue(() => log.push('brightness'));
  await Promise.all([alone, other]);
  assert.deepEqual(log, ['hide', 'show', 'blank', 'brightness']);

  // Nothing queued: an inline call runs, and composites, on the spot.
  log.length = 0;
  void call('frame', true);
  assert.deepEqual(log, ['frame']);
});

test('a caller that always has another compositor call queued still gets frames out', async () => {
  const { log, call } = recorder();
  const calls = [];
  for (let i = 0; i < MAX_MERGED_COMPOSITES + 3; i++) calls.push(call(String(i)));
  await Promise.all(calls);
  const composited = log.filter((entry) => !entry.startsWith('('));
  assert.deepEqual(composited, [String(MAX_MERGED_COMPOSITES), String(MAX_MERGED_COMPOSITES + 2)]);
});

test('merged calls are flushed when the call that was to composite for them throws', async () => {
  const { log, call } = recorder();
  const results = await Promise.allSettled([call('hide'), call('show', false, true)]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected']);
  assert.deepEqual(log, ['(hide)', 'show', 'flush']);

  // A merged call that throws leaves the composite to the one behind it, as it would have anyway;
  // a call that throws with nothing merged before it has nothing to flush.
  log.length = 0;
  await Promise.allSettled([call('hide', false, true), call('show')]);
  await Promise.allSettled([call('alone', false, true)]);
  assert.deepEqual(log, ['(hide)', 'show', 'alone']);
});

test('queued surface changes are reported until they run', async () => {
  const queue = new JavaCallQueue(() => {});
  assert.equal(queue.surfaceChangesQueued, false);
  const visible = queue.enqueueCompositorCall(() => {}, false, true);
  assert.equal(queue.surfaceChangesQueued, false, 'a visibility change leaves surface content alone');
  const frame = queue.enqueueCompositorCall(() => {}, true);
  assert.equal(queue.surfaceChangesQueued, true);
  await Promise.all([visible, frame]);
  assert.equal(queue.surfaceChangesQueued, false);
});
