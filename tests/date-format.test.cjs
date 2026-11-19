const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

// Local-time formatting: pin the zone so the expectations hold on any machine.
process.env.TZ = 'Europe/Brussels';

const { formatEvent, formatEventSpan, formatDateTime } = loader()('app/assistant/date-format.ts');
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test('a multi-day all-day event names its last day (all-day ends are exclusive)', () => {
  // Mon Nov 16 – Wed Nov 18, as the calendar provider stores it: end = midnight after the last day.
  const span = formatEventSpan({ startMs: local(2026, 11, 16), endMs: local(2026, 11, 19), allDay: true }, true);
  assert.equal(span, 'Mon Nov 16 – Wed Nov 18 (all day)');
});

test('a one-day all-day event stays a single date', () => {
  assert.equal(formatEventSpan({ startMs: local(2026, 11, 16), endMs: local(2026, 11, 17), allDay: true }, true), 'Mon Nov 16 (all day)');
});

test('a timed event shows its end time, and the end date when it crosses midnight', () => {
  assert.equal(formatEventSpan({ startMs: local(2026, 11, 19, 9), endMs: local(2026, 11, 19, 12), allDay: false }, true), 'Thu Nov 19, 9:00 AM – 12:00 PM');
  assert.equal(formatEventSpan({ startMs: local(2026, 11, 19, 22), endMs: local(2026, 11, 20, 2), allDay: false }, true), 'Thu Nov 19, 10:00 PM – Fri Nov 20, 2:00 AM');
});

test('a timed event without a usable end keeps the old start-only form', () => {
  assert.equal(formatEventSpan({ startMs: local(2026, 11, 19, 9), endMs: local(2026, 11, 19, 9), allDay: false }, true), 'Thu Nov 19, 9:00 AM');
});

test('times follow the 24-hour setting when it is chosen', () => {
  assert.equal(formatEventSpan({ startMs: local(2026, 11, 19, 9), endMs: local(2026, 11, 19, 14, 30), allDay: false }, false), 'Thu Nov 19, 09:00 – 14:30');
  assert.equal(formatEventSpan({ startMs: local(2026, 11, 19, 22), endMs: local(2026, 11, 20, 2), allDay: false }, false), 'Thu Nov 19, 22:00 – Fri Nov 20, 02:00');
  assert.equal(formatDateTime(new Date(local(2026, 11, 19, 0, 5)), false), 'Thu Nov 19, 00:05');
  assert.equal(formatDateTime(new Date(local(2026, 11, 19, 0, 5)), true), 'Thu Nov 19, 12:05 AM');
});

test('formatEvent keeps the title and location around the span', () => {
  const line = formatEvent({ title: 'Office', startMs: local(2026, 11, 16), endMs: local(2026, 11, 19), allDay: true, location: 'HQ' }, true);
  assert.equal(line, '- Office — Mon Nov 16 – Wed Nov 18 (all day) @ HQ');
  assert.equal(formatEvent({ title: '', startMs: local(2026, 11, 16), endMs: local(2026, 11, 17), allDay: true, location: '' }, true), '- (untitled) — Mon Nov 16 (all day)');
});
