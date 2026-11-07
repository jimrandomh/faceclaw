const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function appIds(registry) {
  const imports = new Map([...registry.matchAll(/^import (\w+) from "\.\/([\w-]+)";$/gm)].map((match) => [match[1], match[2]]));
  const body = registry.slice(registry.indexOf('ALL_APPS'));
  return [...body.matchAll(/^ {2}(?:phoneOnlyApp\("([\w-]+)"|(\w+),$)/gm)].map((match) => match[1] ?? imports.get(match[2]) ?? match[2]);
}

// Every app stays visible in the demo, even those it can't run, so the grid shows what Faceclaw is.
test('the browser demo lists every app, in the same order', () => {
  const web = appIds(read("app/apps/all-apps.web.ts")).map((id) => id.replace(/^demoNightscoutApp$/, "nightscout"));
  assert.deepEqual(web, appIds(read('app/apps/all-apps.ts')));
});

function textureIds() {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(read('app/web/texture-ids.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports });
  return exports;
}

test('atlas ids are a function of the key, and fit their wire fields', () => {
  const { textureFontIdFor, textureImageIdFor } = textureIds();
  for (const key of ['terminus24', 'ttf:Roboto-Light:abc@16g1', 'img:24x24:deadbeef', '']) {
    assert.equal(textureFontIdFor(key), textureFontIdFor(key));
    assert.ok(textureFontIdFor(key) >= 1 && textureFontIdFor(key) <= 0xffff);
    const image = textureImageIdFor(key);
    assert.equal(image, textureImageIdFor(key));
    // Positive as a signed 32-bit read, and clear of ImageAtlas's sequential ids.
    assert.ok(image >= 0x40000000 && image <= 0x7fffffff);
  }
});

// Otherwise the NativeScript virtual entry's require.context pulls them into the phone apps.
test('the phone builds leave out the browser demo', () => {
  const excluded = /ContextExclusionPlugin, \[(\/.*\/)\]/.exec(read('webpack.config.js'));
  assert.ok(excluded);
  const pattern = new Function(`return ${excluded[1]}`)();
  // The plugin tests each directory's entry names, not paths.
  for (const entry of ['web', 'settings-store.web.ts', 'settings-store.webworker.ts']) assert.ok(pattern.test(entry), entry);
  for (const entry of ['settings-store.ts', 'settings-store.ios.ts', 'webview.ts', 'apps', 'web-remote.ts']) assert.ok(!pattern.test(entry), entry);
});
