#!/usr/bin/env node
/**
 * Render every health surface to a PNG, under plain node, with no emulator.
 *
 * ## Why this exists
 *
 * The first pass at this feature verified its layout by building an Android
 * AVD, booting it headless, installing the app and screenshotting it. That
 * works, and it cost most of a three-hour dispatch to set up for a question -
 * "does this layout look right?" - that never needed a device in the loop.
 *
 * Everything the health screens draw goes into a `GrayImage` through code that
 * imports nothing from NativeScript: `health/health-chart.ts` (the primitives),
 * `health/health-glance.ts` (the glasses pages) and
 * `health/health-phone-chart.ts` (the phone bitmap). So this script calls the
 * REAL drawing functions with fixture data and writes what comes back. The
 * previews cannot drift from the app, because they are not a second
 * implementation of it - they are the same functions the device calls.
 *
 * ## The one platform shim, and why it is honest
 *
 * `graphics/bdffont.ts` reads the bundled .bdf through
 * `knownFolders.currentApp()`. That is the only NativeScript call anywhere
 * under the drawing code, so it gets one stub backed by node:fs, pointed at the
 * same `app/fonts/` files the device loads. The glyphs are the real glyphs.
 *
 * ⚠ FONT CAVEAT, worth knowing before reading a preview as gospel. The device's
 * DEFAULT UI font is Roboto-Light at 14px, a TTF - and TTF rasterization on
 * this project happens in Java (`TtfFont.load` bails unless `global.isAndroid`),
 * so it cannot run here. Off Android the shipping code falls back to the
 * Terminus bitmap faces, which is what these previews use. That is a real,
 * user-selectable configuration rather than a preview-only invention, but it is
 * not the default, and text will not be pixel-identical to a device screenshot.
 *
 * The layouts are written against `font.lineHeight` / `measureText` rather than
 * fixed offsets, so what actually matters is whether they survive the font
 * metric range. `--big` re-renders everything one bitmap size up (small 12px ->
 * 16px, large 24px -> 32px) to check exactly that; the guaranteed small-font
 * line-height band is 12..21 (see ui-fonts.ts), and 12 and 16 sit inside it.
 *
 * ## Use
 *
 *     npx tsc -p tests/tsconfig.json      # or: npm test
 *     node tools/health-preview.cjs [--out DIR] [--big] [--real DIR]
 *
 * ## --real: the same surfaces, on data pulled off the phone
 *
 * `--real DIR` reads a `sleep.jsonl` (and, if present, a `samples-*.jsonl`)
 * copied out of `files/health/` under `com.faceclaw.app` and renders the sleep
 * surfaces from THAT instead of from fixtures. Nothing about the drawing
 * changes - it is the same `drawGlancePage` and `renderPhoneChart` - so the
 * question it answers is only ever "what does the real data look like in the
 * layout we already have", never "should the layout be different".
 *
 * A stored session written by a pre-correction build carries
 * `timeResolved: false` and RAW ring seconds. Those are run back through the
 * shipping `convertRecords()` with the real clock correction, so the preview
 * shows what the phone will store after the fix rather than a hand-placed
 * guess. A session already marked resolved is used as-is and not corrected
 * twice.
 */

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "app");
const BUILD = path.join(ROOT, ".test-build", "app");

// --- the one platform shim -------------------------------------------------
const nsCoreStub = {
  knownFolders: {
    currentApp: () => ({
      getFile: (relative) => ({
        readTextSync: () => fs.readFileSync(path.join(APP, relative), "utf8"),
      }),
    }),
  },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@nativescript/core") return nsCoreStub;
  return realLoad.apply(this, arguments);
};

if (!fs.existsSync(BUILD)) {
  console.error(`No ${path.relative(ROOT, BUILD)} - run: npx tsc -p tests/tsconfig.json`);
  process.exit(1);
}

const { GrayImage } = require(path.join(BUILD, "graphics/image.js"));
const { getFont } = require(path.join(BUILD, "graphics/bdffont.js"));
const { buildFixtures } = require(path.join(BUILD, "health/health-fixtures.js"));
const {
  dailySummary,
  hypnogram,
  rollupSeries,
  shortWeekday,
  sleepNights,
  sleepSummary,
  stageSeconds,
  formatDuration,
} = require(path.join(BUILD, "health/health-derive.js"));
const { drawGlancePage, GLANCE_PAGES } = require(path.join(BUILD, "health/health-glance.js"));
const { convertRecords } = require(path.join(BUILD, "health/health-ingest.js"));
const { HealthStore } = require(path.join(BUILD, "health/health-store.js"));
const { renderPhoneChart } = require(path.join(BUILD, "health/health-phone-chart.js"));
const { stageLabel } = require(path.join(BUILD, "health/sleep-stages.js"));
const { DAY_MS, SAMPLE_METRICS, startOfLocalDay } = require(path.join(BUILD, "health/health-types.js"));
const UPNG = require("upng-js");

// --- arguments -------------------------------------------------------------
const args = process.argv.slice(2);
const big = args.includes("--big");
const realIndex = args.indexOf("--real");
const REAL_DIR = realIndex >= 0 && args[realIndex + 1] ? path.resolve(args[realIndex + 1]) : null;
const outIndex = args.indexOf("--out");
const OUT = path.resolve(
  outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : path.join(ROOT, "preview"),
);
fs.mkdirSync(OUT, { recursive: true });

const small = getFont(big ? "terminus16" : "terminus12");
const large = getFont(big ? "terminus32" : "terminus24");
const fonts = { small, large };

// --- real data, when asked for ---------------------------------------------
/**
 * `HealthStorageBackend` over a plain directory.
 *
 * Reading the pulled files THROUGH the real store, rather than parsing them
 * here, is the same rule the rest of this tool follows. The on-disk sample line
 * is a compact seven-key shape (`{m,t,s,n,x,a,u}`) that only `health-store.ts`
 * knows how to read; a hand-rolled parser for it in a preview script is exactly
 * the kind of second implementation that drifts. Read-only - `append`/`write`
 * throw rather than quietly doing nothing, so a preview can never mutate a
 * pulled copy of real data.
 */
class DirBackend {
  constructor(dir) {
    this.dir = dir;
  }
  exists(name) {
    return fs.existsSync(path.join(this.dir, name));
  }
  read(name) {
    return this.exists(name) ? fs.readFileSync(path.join(this.dir, name), "utf8") : null;
  }
  append() {
    throw new Error("health-preview is read-only");
  }
  write() {
    throw new Error("health-preview is read-only");
  }
  list() {
    return fs.readdirSync(this.dir);
  }
}

/**
 * Put a stored session in the frame the corrected build will store it in.
 *
 * The correction is NOT applied here by hand - the record is turned back into
 * the wire shape and pushed through the real `convertRecords()`, so if that
 * function is wrong the preview is wrong in exactly the same way the phone is,
 * which is the only useful behaviour for a check like this.
 */
function resolveStoredSleep(stored) {
  if (stored.timeResolved) return stored;
  const startTs = Math.round(stored.startMs / 1000);
  const endTs = Math.round(stored.endMs / 1000);
  const correction = 2 * new Date(stored.startMs).getTimezoneOffset() * 60 * 1000;
  const { sleep } = convertRecords([
    {
      kind: "sleep",
      startTs,
      endTs,
      totalSec: stored.totalSec,
      wakeSec: stored.wakeSec,
      remSec: stored.remSec,
      lightSec: stored.lightSec,
      deepSec: stored.deepSec,
      segments: stored.segments,
      receivedAtMs: stored.startMs,
      clockCorrectionMs: correction,
    },
  ]);
  return sleep[0];
}

function loadReal(dir) {
  const store = new HealthStore(new DirBackend(dir));
  const sleep = store.sleepSessions().map(resolveStoredSleep);
  if (sleep.length === 0) {
    console.error(`No sleep sessions in ${dir}/sleep.jsonl`);
    process.exit(1);
  }
  // Pin the clock to mid-afternoon of the most recent night's WAKE-UP day, so
  // "today" is the day that night belongs to and the glance reads like a real
  // one rather than an empty day.
  const latest = sleep.reduce((a, b) => (b.dayStartMs > a.dayStartMs ? b : a));
  const nowMs = latest.dayStartMs + 15 * 3600 * 1000 + 20 * 60 * 1000;
  // A bounded window, not (0, MAX): samplesInRange walks a shard per MONTH, so
  // an open range asks it to name a few million files and it returns nothing.
  // A quarter back covers every view this tool renders.
  const samples = store.samplesInRange(nowMs - 120 * DAY_MS, nowMs + DAY_MS);
  console.log(`real data: ${sleep.length} sleep session(s), ${samples.length} samples`);
  for (const night of sleep) {
    console.log(
      `  night ${new Date(night.startMs).toString()}\n` +
        `     -> ${new Date(night.endMs).toString()}` +
        `  total ${night.totalSec}s wake ${night.wakeSec}s` +
        `  timeResolved=${night.timeResolved}`,
    );
  }
  return { samples, sleep, nowMs };
}

// --- data ------------------------------------------------------------------
// A fixed clock so a preview is reproducible and its date caption is stable.
// Mid-afternoon, so "today so far" is a partial day like a real glance.
const real = REAL_DIR ? loadReal(REAL_DIR) : null;
const NOW = real ? real.nowMs : new Date(2026, 8, 10, 15, 20, 0).getTime();
const TODAY = startOfLocalDay(NOW);
const fixtures = real
  ? { samples: real.samples, sleep: real.sleep }
  : buildFixtures({ days: 95, nowMs: NOW, seed: 0x5eed });

const todaySamples = fixtures.samples.filter(
  (sample) => sample.startMs >= TODAY && sample.startMs < TODAY + DAY_MS,
);
const summary = dailySummary(todaySamples, fixtures.sleep, TODAY);
const lastNight = fixtures.sleep.find((session) => session.dayStartMs === TODAY);

const hourly = {};
for (const metric of SAMPLE_METRICS) {
  hourly[metric] = rollupSeries(todaySamples, {
    metric,
    granularity: "hour",
    startMs: TODAY,
    endMs: TODAY + DAY_MS,
  });
}

const glanceData = {
  summary,
  hourly,
  stageBands: lastNight ? hypnogram(lastNight) : [],
  nowMs: NOW,
  // The badge the glasses footer draws. It must follow the DATA, or a real
  // render comes out stamped "Sample data" and the preview lies about the one
  // thing it exists to show.
  fixture: !real,
};

// --- PNG out ---------------------------------------------------------------
const written = [];

function writePng(name, image) {
  const baked = image.withDrawsBaked();
  const rgba = new Uint8Array(baked.width * baked.height * 4);
  for (let i = 0; i < baked.pixels.length; i += 1) {
    const value = baked.pixels[i];
    rgba[i * 4] = value;
    rgba[i * 4 + 1] = value;
    rgba[i * 4 + 2] = value;
    rgba[i * 4 + 3] = 255;
  }
  const file = path.join(OUT, `${REAL_DIR ? "real-" : ""}${name}${big ? "-big" : ""}.png`);
  fs.writeFileSync(file, Buffer.from(UPNG.encode([rgba.buffer], baked.width, baked.height, 0)));

  // A blank canvas would otherwise be a silent pass, and a page that drew
  // nothing is exactly the failure a preview is supposed to catch.
  let lit = 0;
  for (const value of baked.pixels) if (value > 0) lit += 1;
  const inkPercent = ((lit / baked.pixels.length) * 100).toFixed(1);
  written.push({ name: path.basename(file), size: `${baked.width}x${baked.height}`, ink: `${inkPercent}%` });
  if (lit === 0) console.error(`  !! ${file} is entirely blank`);
}

// --- the glasses: 640x480, the G2 lens ------------------------------------
const LENS = { width: 640, height: 480 };
GLANCE_PAGES.forEach((page, index) => {
  const name =
    page.kind === "overview" ? "overview" : page.kind === "sleep" ? "sleep" : page.metric;
  const image = new GrayImage(LENS.width, LENS.height, 0);
  drawGlancePage(image, LENS, fonts, page, glanceData);
  writePng(`glasses-${String(index + 1).padStart(2, "0")}-${name}`, image);
});

// --- the phone -------------------------------------------------------------
/**
 * Two widths, both real: 411dp is the Fold 7's cover screen (the compact
 * layout), 750dp its inner screen (expanded). Both are the numbers the first
 * pass measured on screen in the emulator, so the previews line up with the
 * readout in those screenshots. The chart renders at RENDER_SCALE 2 into a box
 * of (width - 32)dp, matching health-view-model.ts.
 */
const RENDER_SCALE = 2;
const PHONE_LAYOUTS = [
  { name: "narrow", widthDp: 411, chartHeightDp: 190 },
  { name: "wide", widthDp: 750, chartHeightDp: 380 },
];

function phoneChart(layout, name, content) {
  const image = renderPhoneChart({
    width: Math.round((layout.widthDp - 32) * RENDER_SCALE),
    height: Math.round(layout.chartHeightDp * RENDER_SCALE),
    font: small,
    content,
  });
  writePng(`phone-${layout.name}-${name}`, image);
}

function metricContent(metric, granularity, days) {
  const startMs = TODAY - (days - 1) * DAY_MS;
  const points = rollupSeries(fixtures.samples, {
    metric,
    granularity,
    startMs,
    endMs: TODAY + DAY_MS,
  });
  return {
    kind: "metric",
    metric,
    points,
    mode: metric === "steps" || metric === "calories" ? "bars" : "band",
    xLabel: (point) =>
      granularity === "hour"
        ? `${new Date(point.startMs).getHours()}`
        : days <= 7
          ? shortWeekday(point.startMs)
          : `${new Date(point.startMs).getDate()}`,
  };
}

function nightsContent(days) {
  const startMs = TODAY - (days - 1) * DAY_MS;
  return {
    kind: "nights",
    nights: sleepNights(fixtures.sleep, startMs, TODAY + DAY_MS),
    xLabel: (night) =>
      days <= 7 ? shortWeekday(night.startMs) : `${new Date(night.startMs).getDate()}`,
  };
}

function lanesContent() {
  const summaryOfNight = lastNight ? sleepSummary(lastNight) : null;
  return {
    kind: "lanes",
    bands: lastNight ? hypnogram(lastNight) : [],
    laneText: (stage) => ({
      label: stageLabel(stage),
      value: summaryOfNight ? formatDuration(stageSeconds(stage, summaryOfNight)) : "--",
    }),
  };
}

for (const layout of PHONE_LAYOUTS) {
  phoneChart(layout, "hr-day", metricContent("heartRate", "hour", 1));
  phoneChart(layout, "hr-week", metricContent("heartRate", "day", 7));
  phoneChart(layout, "spo2-day", metricContent("spo2", "hour", 1));
  phoneChart(layout, "steps-week", metricContent("steps", "day", 7));
  phoneChart(layout, "sleep-day-lanes", lanesContent());
  phoneChart(layout, "sleep-week", nightsContent(7));
  phoneChart(layout, "sleep-month", nightsContent(30));
  phoneChart(layout, "sleep-quarter", nightsContent(90));
}

// --- report ----------------------------------------------------------------
console.log(`font: small lineHeight ${small.lineHeight}, large lineHeight ${large.lineHeight}`);
console.log(`wrote ${written.length} PNGs to ${OUT}\n`);
for (const entry of written) {
  console.log(`  ${entry.name.padEnd(34)} ${entry.size.padEnd(10)} ink ${entry.ink}`);
}
