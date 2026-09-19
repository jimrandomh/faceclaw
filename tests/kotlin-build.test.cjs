const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkAndroidRuntime } = require('../scripts/kotlin-build.cjs');

test('Android preparation rejects a stale metadata generator but allows fresh and matching platforms', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-kotlin-build-'));
  try {
    const installed = path.join(root, 'node_modules/@nativescript/android/framework/build-tools/android-metadata-generator.jar');
    const generated = path.join(root, 'platforms/android/build-tools/android-metadata-generator.jar');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, 'current metadata generator');
    assert.doesNotThrow(() => checkAndroidRuntime(root));
    fs.mkdirSync(path.dirname(generated), { recursive: true });
    fs.writeFileSync(generated, 'old metadata generator');
    assert.throws(() => checkAndroidRuntime(root), /ns platform clean android/);
    fs.copyFileSync(installed, generated);
    assert.doesNotThrow(() => checkAndroidRuntime(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every remaining Java source has an explicit Android boundary and every migration has one replacement', () => {
  const root = path.resolve(__dirname, '..');
  const java = path.join(root, 'App_Resources/Android/src/main/java');
  const list = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? list(file) : file.endsWith('.java') ? [path.relative(java, file)] : [];
  });
  const boundaries = require('../native/kotlin/android-java-boundaries.json');
  const retained = boundaries.flatMap(group => { assert.ok(group.reason.length > 20); return group.files; });
  assert.deepEqual(list(java).sort(), retained.sort());
  assert.equal(new Set(retained).size, retained.length);
  const migrated = require('../native/kotlin/migrated-java-sources.json');
  assert.equal(new Set(migrated.map(entry => entry.java)).size, migrated.length);
  for (const entry of migrated) {
    assert.equal(fs.existsSync(path.join(java, entry.java)), false, entry.java);
    assert.ok(fs.existsSync(path.join(root, 'native/kotlin', entry.kotlin)), entry.kotlin);
  }
});
