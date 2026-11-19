const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Local-time day arithmetic: pin the zone so the expectations hold on any machine.
process.env.TZ = 'Europe/Brussels';

function load(file) {
  const sandbox = { exports: {}, require: id => { throw new Error(`Unstubbed import: ${id}`); } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, sandbox);
  return sandbox.exports;
}

const { listingDayMs, spansDays, spanLabel } = load('app/apps/calendar/event-days.ts');
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
// Mon Nov 16 – Wed Nov 18, all day, as the provider stores it (end = midnight after the last day).
const threeDays = { startMs: local(2026, 11, 16), endMs: local(2026, 11, 19), allDay: true };

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
  const lateShift = { startMs: local(2026, 11, 17, 22), endMs: local(2026, 11, 18, 2), allDay: false };
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
