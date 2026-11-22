const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

// Local-time day arithmetic: pin the zone so the expectations hold on any machine.
process.env.TZ = 'Europe/Brussels';

const load = loader();
const { listingDayMs, spansDays, spanLabel, endTimeLabel, carriedOverLabel } = load('app/apps/calendar/event-days.ts');
const { formatHourMinute } = load('app/util/date-util.ts');
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const time24 = ms => formatHourMinute(new Date(ms), false);
// Mon Nov 16 – Wed Nov 18, all day, as the provider stores it (end = midnight after the last day).
const threeDays = { startMs: local(2026, 11, 16), endMs: local(2026, 11, 19), allDay: true };
// Tue Nov 17 22:00 – Wed Nov 18 02:00.
const lateShift = { startMs: local(2026, 11, 17, 22), endMs: local(2026, 11, 18, 2), allDay: false };
// Mon Nov 16 09:00 – Fri Nov 20 17:00.
const conference = { startMs: local(2026, 11, 16, 9), endMs: local(2026, 11, 20, 17), allDay: false };

test('an all-day event still going is listed under today, not its first day', () => {
  assert.equal(listingDayMs(threeDays, local(2026, 11, 18, 0, 24)), local(2026, 11, 18));
  assert.equal(listingDayMs(threeDays, local(2026, 11, 17, 9)), local(2026, 11, 17));
});

test('events that have not started are listed under their start day', () => {
  assert.equal(listingDayMs(threeDays, local(2026, 11, 14, 12)), local(2026, 11, 16));
  const meeting = { startMs: local(2026, 11, 19, 9), endMs: local(2026, 11, 19, 12), allDay: false };
  assert.equal(listingDayMs(meeting, local(2026, 11, 18, 0, 24)), local(2026, 11, 19));
});

test('a timed event running past midnight is listed under today the next morning', () => {
  assert.equal(listingDayMs(lateShift, local(2026, 11, 18, 0, 30)), local(2026, 11, 18));
  assert.equal(spansDays(lateShift), true);
});

test('only events covering more than one day get a span, and it reads naturally', () => {
  assert.equal(spansDays(threeDays), true);
  assert.equal(spanLabel(threeDays), 'Mon 16 – Wed 18 Nov');
  assert.equal(spansDays({ startMs: local(2026, 11, 16), endMs: local(2026, 11, 17), allDay: true }), false);
  assert.equal(spansDays({ startMs: local(2026, 11, 19, 9), endMs: local(2026, 11, 19, 12), allDay: false }), false);
  assert.equal(spanLabel({ startMs: local(2026, 11, 30), endMs: local(2026, 12, 2), allDay: true }), 'Mon 30 Nov – Tue 1 Dec');
});

test('a timed event ending exactly at midnight stays on its own day', () => {
  const evening = { startMs: local(2026, 11, 19, 22), endMs: local(2026, 11, 20), allDay: false };
  assert.equal(spansDays(evening), false);
  assert.equal(listingDayMs(evening, local(2026, 11, 19, 23)), local(2026, 11, 19));
  assert.equal(endTimeLabel(evening, evening.startMs, time24), '00:00');
});

test('the end of a timed event names its day only when it is not the reference day', () => {
  assert.equal(endTimeLabel(lateShift, local(2026, 11, 18, 0, 30), time24), '02:00');
  assert.equal(endTimeLabel(lateShift, lateShift.startMs, time24), 'Wed 02:00');
  assert.equal(endTimeLabel(conference, local(2026, 11, 18, 12), time24), 'Fri 17:00');
  // A week or more away, a weekday alone would be ambiguous.
  const course = { startMs: local(2026, 11, 16, 9), endMs: local(2026, 11, 27, 17), allDay: false };
  assert.equal(endTimeLabel(course, local(2026, 11, 18, 12), time24), '27 Nov 17:00');
  // Ending at midnight two days on, the end is named by the day it falls on.
  const toFriday = { startMs: local(2026, 11, 17, 9), endMs: local(2026, 11, 20), allDay: false };
  assert.equal(endTimeLabel(toFriday, local(2026, 11, 18, 12), time24), 'Fri 00:00');
});

test('a timed event carried over from an earlier day reads as when it ends, not its start', () => {
  assert.equal(carriedOverLabel(lateShift, local(2026, 11, 18, 0, 30), time24), 'Until 02:00');
  assert.equal(carriedOverLabel(conference, local(2026, 11, 18, 12), time24), 'Until Fri 17:00');
  // Ending at midnight tonight still ends today.
  const toMidnight = { startMs: local(2026, 11, 17, 9), endMs: local(2026, 11, 19), allDay: false };
  assert.equal(carriedOverLabel(toMidnight, local(2026, 11, 18, 12), time24), 'Until 00:00');
  // Not carried over: on its first day, before it starts, or all-day (whose row says "All day").
  assert.equal(carriedOverLabel(lateShift, local(2026, 11, 17, 23), time24), null);
  assert.equal(carriedOverLabel(conference, local(2026, 11, 14, 12), time24), null);
  assert.equal(carriedOverLabel(threeDays, local(2026, 11, 18, 12), time24), null);
});
