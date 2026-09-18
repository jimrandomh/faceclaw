const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

// Run the actual live ingest, seed and file-backend modules with NativeScript
// files and the Java communicator replaced at their platform boundaries.
function liveEnvironment() {
  const files = new Map();
  const cache = new Map();
  const faults = { append: null, remove: null, write: null };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  let consumed = false;
  const record = {
    cmdHi: 1,
    anchorUnixSeconds: (start + today.getTimezoneOffset() * 60000) / 1000,
    groups: [{ hourIndex: 0, min: 40, max: 50, avg: 45 }],
  };
  const communicator = {
    takeRingHealthBatch: () => ({
      getWatermark: () => 1,
      getRecords: () => ({ size: () => consumed ? 0 : 1, get: () => record }),
    }),
    clearRingHealthRecordsBelow: () => { consumed = true; return 1; },
  };
  const native = {
    File: {
      exists: (name) => files.has(name),
      fromPath: (name) => ({
        readTextSync: () => files.get(name),
        appendTextSync: (text, onError) => {
          if (faults.append) return onError(faults.append);
          files.set(name, (files.get(name) ?? "") + text);
        },
        writeTextSync: (text, onError) => {
          if (faults.write) return onError(faults.write);
          files.set(name, text);
        },
        removeSync: (onError) => {
          if (faults.remove) return onError(faults.remove);
          files.delete(name);
        },
      }),
    },
    knownFolders: { documents: () => ({ getFolder: () => ({
      path: "/health",
      getEntitiesSync: () => [...files.keys()].map((name) => ({ path: name, name: path.basename(name) })),
    }) }) },
  };
  function load(filename) {
    if (!filename.endsWith(".ts")) filename += ".ts";
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(code, {
      module, exports: module.exports, Date,
      require: (name) => name === "@nativescript/core" ? native : load(path.resolve(path.dirname(filename), name)),
      console: { log() {}, warn() {} },
      com: { faceclaw: { app: { FaceclawBleCommunicator: { getActive: () => communicator } } } },
    }, { filename });
    return module.exports;
  }
  return {
    files, faults, start, consumed: () => consumed,
    load: (name) => load(path.join(__dirname, "../app/health", name)),
  };
}

test("first live sync removes fixture samples, sleep and rollups from memory and disk", () => {
  const env = liveEnvironment();
  const seed = env.load("health-seed");
  const store = env.load("health-store-files").healthStore();
  assert.equal(seed.seedFixturesIfNeeded(2), true);
  assert.ok(store.sleepSessions().length > 0);
  assert.ok(store.samplesInRange(env.start, env.start + 86400000).length > 1);

  env.load("health-live").syncLiveRecords();
  assert.equal(seed.isFixtureData(), false);
  assert.equal(env.consumed(), true);
  assert.equal(store.sleepSessions().length, 0);
  const samples = store.samplesInRange(env.start, env.start + 86400000);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].avg, 45);
  const rollups = JSON.parse(env.files.get("/health/rollups.json"));
  assert.equal(Object.keys(rollups.days).length, 1);
  const day = Object.values(rollups.days)[0];
  assert.deepEqual(Object.keys(day), ["heartRate"]);
  assert.equal(day.heartRate.count, 1);
});

test("a failed fixture purge retains the badge and ring batch until retry succeeds", () => {
  const env = liveEnvironment();
  const seed = env.load("health-seed");
  seed.seedFixturesIfNeeded(2);
  const live = env.load("health-live");
  env.faults.remove = new Error("delete failed");
  assert.throws(() => live.syncLiveRecords(), /delete failed/);
  assert.equal(env.consumed(), false);
  assert.equal(seed.isFixtureData(), true);
  env.faults.remove = null;
  live.syncLiveRecords();
  assert.equal(env.consumed(), true);
  assert.equal(seed.isFixtureData(), false);
});

test("NativeScript append callback failures retain the batch and retry persists it", () => {
  const env = liveEnvironment();
  const live = env.load("health-live");
  env.faults.append = { message: "disk full" };
  assert.throws(() => live.syncLiveRecords(), /disk full/);
  assert.equal(env.consumed(), false);
  assert.equal([...env.files.keys()].filter((name) => name.includes("samples-")).length, 0);
  env.faults.append = null;
  assert.equal(live.syncLiveRecords().samplesWritten, 1);
  assert.equal(env.consumed(), true);
  assert.equal([...env.files.keys()].filter((name) => name.includes("samples-")).length, 1);
});

test("NativeScript rollup write callback failures propagate without consuming the batch", () => {
  const env = liveEnvironment();
  env.faults.write = { message: "write failed" };
  assert.throws(() => env.load("health-live").syncLiveRecords(), /write failed/);
  assert.equal(env.consumed(), false);
  env.faults.write = null;
  assert.equal(env.load("health-live").syncLiveRecords().samplesWritten, 0);
  assert.equal(env.consumed(), true);
  assert.equal(env.files.has("/health/rollups.json"), true);
  assert.equal(env.load("health-seed").hasLiveData(), true);
  assert.equal(env.load("health-seed").seedFixturesIfNeeded(), false);
});

test("a failed fixture append stays labelled and is purged before live ingest", () => {
  const env = liveEnvironment();
  const seed = env.load("health-seed");
  env.faults.append = new Error("disk full");
  assert.equal(seed.seedFixturesIfNeeded(2), false);
  assert.equal(seed.isFixtureData(), true);
  env.faults.append = null;
  env.load("health-live").syncLiveRecords();
  assert.equal(seed.isFixtureData(), false);
  assert.equal(env.load("health-store-files").healthStore().sleepSessions().length, 0);
});
