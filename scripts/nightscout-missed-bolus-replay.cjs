#!/usr/bin/env node
// Replays the missed-bolus detector (app/apps/nightscout/missed-bolus-detector.ts)
// over recorded Nightscout history, as if it had run after every CGM reading
// with the app's cooldown, and lists where it would have alerted next to the
// meal boluses around them. For tuning the detector without the glasses.
//
//   node scripts/nightscout-missed-bolus-replay.cjs --site https://x.herokuapp.com --token TOKEN --days 14
//   node scripts/nightscout-missed-bolus-replay.cjs --site ... --token ... --days 30 --save /tmp/ns
//   node scripts/nightscout-missed-bolus-replay.cjs --load /tmp/ns --set minRiseMgdl=50 --set minRateMgdlPerMin=2
//
// --site/--token default to $NIGHTSCOUT_URL/$NIGHTSCOUT_TOKEN. --save writes
// the fetched entries.json/treatments.json to a directory; --load replays a
// saved directory instead of fetching. --set overrides one detector option
// (see MissedBolusOptions); --cooldown-min sets the alert cooldown (default
// 120, the app's default); --verbose also prints every classification change.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const DETECTOR = path.join(__dirname, '../app/apps/nightscout/missed-bolus-detector.ts');
// Matches the bridge's history window: the detector looks back 90 min, plus slack.
const HISTORY_WINDOW_MS = 3 * 60 * 60_000;
// The app sees a reading at the next minutely sync after its upload.
const SYNC_LAG_MS = 60_000;
// A meal bolus this soon after an alert counts as the alert being answered.
const ANSWER_WINDOW_MS = 3 * 60 * 60_000;

function loadDetector() {
  const source = ts.transpileModule(fs.readFileSync(DETECTOR, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports }, { filename: DETECTOR });
  return exports;
}

function parseArgs(argv) {
  const args = { site: process.env.NIGHTSCOUT_URL ?? '', token: process.env.NIGHTSCOUT_TOKEN ?? '', days: 14, cooldownMin: 120, set: {}, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === '--site') args.site = value().replace(/\/+$/, '');
    else if (flag === '--token') args.token = value();
    else if (flag === '--days') args.days = Number(value());
    else if (flag === '--save') args.save = value();
    else if (flag === '--load') args.load = value();
    else if (flag === '--cooldown-min') args.cooldownMin = Number(value());
    else if (flag === '--verbose') args.verbose = true;
    else if (flag === '--set') {
      const [key, raw] = value().split('=');
      args.set[key] = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
    } else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.replace(/token=[^&]*/, 'token=...')}`);
  return response.json();
}

async function loadHistory(args) {
  if (args.load) {
    return {
      entries: JSON.parse(fs.readFileSync(path.join(args.load, 'entries.json'), 'utf8')),
      treatments: JSON.parse(fs.readFileSync(path.join(args.load, 'treatments.json'), 'utf8')),
    };
  }
  if (!args.site || !args.token) throw new Error('need --site and --token (or $NIGHTSCOUT_URL/$NIGHTSCOUT_TOKEN), or --load');
  const startMs = Date.now() - args.days * 86_400_000;
  const token = `token=${encodeURIComponent(args.token)}`;
  // Room for 1-minute CGMs; Nightscout otherwise caps a query at 10 results.
  const count = Math.ceil(args.days * 1440 * 1.1);
  const [entries, treatments] = await Promise.all([
    fetchJson(`${args.site}/api/v1/entries/sgv.json?find%5Bdate%5D%5B%24gte%5D=${startMs}&count=${count}&${token}`),
    fetchJson(`${args.site}/api/v1/treatments.json?find%5Bcreated_at%5D%5B%24gte%5D=${encodeURIComponent(new Date(startMs).toISOString())}&count=${count}&${token}`),
  ]);
  if (args.save) {
    fs.mkdirSync(args.save, { recursive: true });
    fs.writeFileSync(path.join(args.save, 'entries.json'), JSON.stringify(entries));
    fs.writeFileSync(path.join(args.save, 'treatments.json'), JSON.stringify(treatments));
  }
  return { entries, treatments };
}

function formatTime(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function minutes(ms) {
  return `${Math.round(ms / 60_000)} min`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const detector = loadDetector();
  for (const key of Object.keys(args.set)) {
    if (!(key in detector.DEFAULT_MISSED_BOLUS_OPTIONS)) throw new Error(`unknown detector option ${key}`);
  }
  const { entries, treatments } = await loadHistory(args);
  const glucose = detector.normalizeNightscoutEntries(entries);
  const { boluses, carbs } = detector.normalizeNightscoutTreatments(treatments);
  const mealBoluses = boluses.filter((bolus) => bolus.kind === 'meal');
  if (!glucose.length) throw new Error('no glucose entries');

  const cooldownMs = args.cooldownMin * 60_000;
  const alerts = [];
  let lastAlertMs = -Infinity;
  let lastSummary = '';
  let first = 0;
  for (const reading of glucose) {
    const nowMs = reading.timeMs + SYNC_LAG_MS;
    while (glucose[first].timeMs < nowMs - HISTORY_WINDOW_MS) first++;
    const inWindow = (event) => event.timeMs >= nowMs - HISTORY_WINDOW_MS && event.timeMs <= nowMs;
    const result = detector.detectMissedBolus({
      nowMs,
      glucose: glucose.slice(first).filter((r) => r.timeMs <= nowMs),
      boluses: boluses.filter(inWindow),
      carbs: carbs.filter(inWindow),
    }, args.set);
    const summary = `${result.classification}: ${result.reason}`;
    if (args.verbose && summary !== lastSummary) console.log(`  ${formatTime(nowMs)}  ${reading.mgdl}  ${summary}`);
    lastSummary = summary;
    if (result.classification !== 'missed-bolus' || nowMs - lastAlertMs < cooldownMs) continue;
    lastAlertMs = nowMs;
    alerts.push({ nowMs, result });
  }

  const spanDays = (glucose[glucose.length - 1].timeMs - glucose[0].timeMs) / 86_400_000;
  console.log(`${glucose.length} readings over ${spanDays.toFixed(1)} days; ${mealBoluses.length} meal boluses; ${boluses.filter((b) => b.kind === 'ambiguous').length} unmarked boluses (max ${Math.max(0, ...boluses.filter((b) => b.kind === 'ambiguous').map((b) => b.units))} U)`);
  console.log(`options: ${JSON.stringify({ ...detector.DEFAULT_MISSED_BOLUS_OPTIONS, ...args.set })}`);
  console.log(`\n${alerts.length} alerts (${(alerts.length / Math.max(spanDays, 1 / 24)).toFixed(2)}/day, cooldown ${args.cooldownMin} min):`);
  for (const { nowMs, result } of alerts) {
    const answer = mealBoluses.find((bolus) => bolus.timeMs > nowMs && bolus.timeMs - nowMs <= ANSWER_WINDOW_MS);
    const note = answer ? `meal bolus ${answer.units} U ${minutes(answer.timeMs - nowMs)} later` : 'no meal bolus within 3 h';
    console.log(`  ${formatTime(nowMs)}  ${result.rise.latestMgdl} mg/dL  ${result.reason}  [${note}]`);
  }
  console.log('\nmeal boluses:');
  for (const bolus of mealBoluses) {
    const alert = alerts.find(({ nowMs }) => nowMs < bolus.timeMs && bolus.timeMs - nowMs <= ANSWER_WINDOW_MS);
    const meal = carbs.find((entry) => entry.timeMs === bolus.timeMs);
    console.log(`  ${formatTime(bolus.timeMs)}  ${bolus.units} U${meal ? ` ${meal.grams} g` : ''}${alert ? `  [alerted ${minutes(bolus.timeMs - alert.nowMs)} before]` : ''}`);
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
