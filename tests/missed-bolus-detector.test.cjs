const test = require('node:test');
const assert = require('node:assert/strict');
const detector = require('../.test-build/app/apps/nightscout/missed-bolus-detector.js');

const MIN = 60_000;
const T0 = 1_800_000_000_000;

/**
 * 5-minute readings: flat at `base` for `flatMin`, then rising `rate` mg/dL
 * per minute for `riseMin`. The rise starts at T0 + flatMin.
 */
function series({ base = 100, flatMin = 60, rate = 2.5, riseMin = 40 } = {}) {
  const readings = [];
  for (let m = 0; m <= flatMin + riseMin; m += 5) {
    readings.push({ timeMs: T0 + m * MIN, mgdl: Math.round(base + Math.max(0, m - flatMin) * rate) });
  }
  return readings;
}

/** A detector input one minute after the last reading. */
function input(glucose, { boluses = [], carbs = [] } = {}) {
  return { nowMs: glucose[glucose.length - 1].timeMs + MIN, glucose, boluses, carbs };
}

const onset = T0 + 60 * MIN;

test('an unannounced meal-shaped rise is a missed bolus', () => {
  const result = detector.detectMissedBolus(input(series()));
  assert.equal(result.classification, 'missed-bolus', result.reason);
  assert.equal(result.rise.onsetMs, onset);
  assert.equal(result.rise.nadirMgdl, 100);
  assert.equal(result.rise.latestMgdl, 200);
  assert.equal(result.rise.riseMgdl, 100);
  assert.ok(Math.abs(result.rise.rateMgdlPerMin - 2.5) < 0.01);
});

test('a meal or manual bolus from the pre-bolus window onward accounts for the rise', () => {
  for (const [kind, offsetMin] of [['meal', -50], ['meal', 15], ['manual', 30]]) {
    const result = detector.detectMissedBolus(input(series(), {
      boluses: [{ timeMs: onset + offsetMin * MIN, units: 5, kind }],
    }));
    assert.equal(result.classification, 'no-alert', `${kind} at ${offsetMin}: ${result.reason}`);
  }
  // Too long before the rise began, or too small, doesn't count.
  for (const bolus of [{ timeMs: onset - 70 * MIN, units: 5, kind: 'meal' }, { timeMs: onset, units: 0.3, kind: 'meal' }]) {
    assert.equal(detector.detectMissedBolus(input(series(), { boluses: [bolus] })).classification, 'missed-bolus');
  }
});

test('loop boluses do not count; unmarked ones count only above the SMB size threshold', () => {
  const smbs = [0, 10, 20, 30].map((m) => ({ timeMs: onset + m * MIN, units: 1.4, kind: 'ambiguous' }));
  smbs.push({ timeMs: onset + 5 * MIN, units: 3, kind: 'automatic' });
  assert.equal(detector.detectMissedBolus(input(series(), { boluses: smbs })).classification, 'missed-bolus');
  const manual = [{ timeMs: onset + 20 * MIN, units: 2, kind: 'ambiguous' }];
  assert.equal(detector.detectMissedBolus(input(series(), { boluses: manual })).classification, 'no-alert');
  assert.equal(detector.detectMissedBolus(input(series(), { boluses: manual }), { ambiguousBolusMinUnits: 2.5 }).classification, 'missed-bolus');
});

test('a carb entry accounts for the rise unless that option is off', () => {
  const carbs = [{ timeMs: onset + 10 * MIN, grams: 40 }];
  assert.equal(detector.detectMissedBolus(input(series(), { carbs })).classification, 'no-alert');
  assert.equal(detector.detectMissedBolus(input(series(), { carbs }), { carbsCountAsAnnouncement: false }).classification, 'missed-bolus');
});

test('rises that are small, slow, brief, low, or from a hypo do not alert', () => {
  const cases = [
    series({ rate: 0.9, riseMin: 60 }), // slow: under 1.5 mg/dL/min
    series({ rate: 3, riseMin: 15 }), // brief: 15 min
    series({ base: 80, rate: 1.6, riseMin: 30 }), // ends at 128, under 140
    series({ base: 60, rate: 3, riseMin: 40 }), // recovering from a low
    series({ base: 150, rate: 1.5, riseMin: 20 }), // only 30 mg/dL
  ];
  for (const glucose of cases) {
    const result = detector.detectMissedBolus(input(glucose));
    assert.equal(result.classification, 'no-alert', result.reason);
    assert.ok(result.rise);
  }
});

test('a rise that has peaked and turned down does not alert', () => {
  const glucose = series();
  const last = glucose[glucose.length - 1];
  for (let m = 5; m <= 20; m += 5) glucose.push({ timeMs: last.timeMs + m * MIN, mgdl: last.mgdl - m });
  assert.equal(detector.detectMissedBolus(input(glucose)).classification, 'no-alert');
});

test('stale, missing, or gapped data is insufficient', () => {
  const glucose = series();
  const stale = { ...input(glucose), nowMs: glucose[glucose.length - 1].timeMs + 20 * MIN };
  assert.equal(detector.detectMissedBolus(stale).classification, 'insufficient-data');
  assert.equal(detector.detectMissedBolus({ nowMs: T0, glucose: [], boluses: [], carbs: [] }).classification, 'insufficient-data');
  // Readings after "now" are ignored rather than used.
  const early = { ...input(glucose), nowMs: onset + 11 * MIN };
  assert.notEqual(detector.detectMissedBolus(early).classification, 'missed-bolus');
  // A CGM dropout splits the window: the rise before it doesn't count.
  const gapped = series().filter((r) => r.timeMs < onset + 10 * MIN || r.timeMs > onset + 30 * MIN);
  assert.notEqual(detector.detectMissedBolus(input(gapped)).classification, 'missed-bolus');
  // Dexcom error codes are dropped; 39 ("LOW") is a real reading.
  const withErrors = series().map((r, i) => (i === 3 ? { ...r, mgdl: 5 } : r));
  assert.equal(detector.detectMissedBolus(input(withErrors)).classification, 'missed-bolus');
});

test('bolus kinds from each uploader', () => {
  const kind = detector.bolusKindFromTreatment;
  assert.equal(kind({ eventType: 'Correction Bolus', insulin: 0.5, automatic: true }), 'automatic'); // Loop
  assert.equal(kind({ eventType: 'Correction Bolus', insulin: 0.5, automatic: false }), 'manual'); // Loop
  assert.equal(kind({ eventType: 'Correction Bolus', insulin: 0.4, isSMB: true }), 'automatic'); // AndroidAPS
  assert.equal(kind({ eventType: 'Correction Bolus', insulin: 0.4, type: 'SMB' }), 'automatic'); // Trio
  assert.equal(kind({ eventType: 'SMB', insulin: 0.4 }), 'automatic');
  assert.equal(kind({ eventType: 'Meal Bolus', insulin: 4 }), 'meal');
  assert.equal(kind({ eventType: 'Bolus', insulin: 4, carbs: 30 }), 'meal');
  assert.equal(kind({ eventType: 'Correction Bolus', insulin: 4, wizard: { carb_input: 0 } }), 'meal');
  // OpenAPS on a Medtronic pump: SMBs and manual corrections look the same.
  assert.equal(kind({ eventType: 'Correction Bolus', insulin: 0.3, carbs: null, enteredBy: 'openaps://medtronic/723' }), 'ambiguous');
});

test('normalizing raw Nightscout records', () => {
  const { boluses, carbs } = detector.normalizeNightscoutTreatments([
    { eventType: 'Meal Bolus', created_at: '2026-10-11T23:05:32.000Z', insulin: 10.7, carbs: 75, wizard: {} },
    { eventType: 'Correction Bolus', created_at: '2026-10-11T22:05:00.000Z', insulin: 0.3, carbs: null },
    { eventType: 'Temp Basal', created_at: '2026-10-11T22:00:00.000Z', insulin: null, carbs: null, rate: 1.2 },
    { eventType: 'Carb Correction', timestamp: '2026-10-11T21:00:00.000Z', carbs: '15' },
    { eventType: 'Correction Bolus', insulin: 1 }, // no time
  ]);
  assert.deepEqual(boluses, [
    { timeMs: Date.parse('2026-10-11T22:05:00.000Z'), units: 0.3, kind: 'ambiguous' },
    { timeMs: Date.parse('2026-10-11T23:05:32.000Z'), units: 10.7, kind: 'meal' },
  ]);
  assert.deepEqual(carbs, [
    { timeMs: Date.parse('2026-10-11T21:00:00.000Z'), grams: 15 },
    { timeMs: Date.parse('2026-10-11T23:05:32.000Z'), grams: 75 },
  ]);
  assert.deepEqual(
    detector.normalizeNightscoutEntries([{ date: 2000, sgv: 120 }, { date: 1000, sgv: 110 }, { date: 3000 }]),
    [{ timeMs: 1000, mgdl: 110 }, { timeMs: 2000, mgdl: 120 }],
  );
});
