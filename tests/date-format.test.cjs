const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Local-time formatting: pin the zone so the expectations hold on any machine.
process.env.TZ = 'Europe/Brussels';

function load(file) {
  const sandbox = { exports: {}, require: id => { throw new Error(`Unstubbed import: ${id}`); } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, sandbox);
  return sandbox.exports;
}

const { formatEvent, formatEventSpan } = load('app/assistant/date-format.ts');
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test('a multi-day all-day event names its last day (all-day ends are exclusive)', () => {
  // Mon Nov 16 – Wed Nov 18, as the calendar provider stores it: end = midnight after the last day.
  const span = formatEventSpan({ startMs: local(2026, 11, 16), endMs: local(2026, 11, 19), allDay: true });
  assert.equal(span, 'Mon Nov 16 – Wed Nov 18 (all day)');
});

test('a one-day all-day event stays a single date', () => {
  assert.equal(formatEventSpan({ startMs: local(2026, 11, 16), endMs: local(2026, 11, 17), allDay: true }), 'Mon Nov 16 (all day)');
});

test('a timed event shows its end time, and the end date when it crosses midnight', () => {
  assert.equal(formatEventSpan({ startMs: local(2026, 11, 19, 9), endMs: local(2026, 11, 19, 12), allDay: false }), 'Thu Nov 19, 9:00 AM – 12:00 PM');
  assert.equal(formatEventSpan({ startMs: local(2026, 11, 19, 22), endMs: local(2026, 11, 20, 2), allDay: false }), 'Thu Nov 19, 10:00 PM – Fri Nov 20, 2:00 AM');
});

test('a timed event without a usable end keeps the old start-only form', () => {
  assert.equal(formatEventSpan({ startMs: local(2026, 11, 19, 9), endMs: local(2026, 11, 19, 9), allDay: false }), 'Thu Nov 19, 9:00 AM');
});

test('formatEvent keeps the title and location around the span', () => {
  const line = formatEvent({ title: 'Office', startMs: local(2026, 11, 16), endMs: local(2026, 11, 19), allDay: true, location: 'HQ' });
  assert.equal(line, '- Office — Mon Nov 16 – Wed Nov 18 (all day) @ HQ');
  assert.equal(formatEvent({ title: '', startMs: local(2026, 11, 16), endMs: local(2026, 11, 17), allDay: true, location: '' }), '- (untitled) — Mon Nov 16 (all day)');
});
