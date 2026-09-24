const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function load(file, requireModule, globals = {}) {
  const context = { exports: {}, require: requireModule, console, ...globals };
  vm.runInNewContext(ts.transpileModule(source(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}
function store(settings = new Map()) {
  const listeners = [];
  const storage = {
    getStringSetting: (key, fallback) => settings.get(key) ?? fallback,
    setStringSetting: (key, value) => {
      settings.set(key, value);
      for (const listener of listeners) listener(key);
    },
    onSettingsStoreChanged: (listener) => { listeners.push(listener); return () => {}; },
  };
  return { prefs: load('app/native/media-apps.ts', () => storage), storage };
}
const chrome = { packageName: 'com.android.chrome', appName: 'Chrome' };
const player = { packageName: 'com.player', appName: 'Player' };

test('defaults apply before discovery; explicit choices survive restart, renames and rediscovery', () => {
  const settings = new Map();
  let { prefs } = store(settings);
  assert.equal(prefs.isMediaAppEnabled(chrome.packageName), false);
  assert.equal(prefs.isMediaAppEnabled(player.packageName), true);
  assert.equal(prefs.isMediaAppEnabled('com.android.chrome.music'), true);
  prefs.rememberMediaApps([chrome, player, player, { packageName: '', appName: 'Invalid' }]);
  assert.equal(prefs.readMediaApps().length, 2);
  prefs.setMediaAppEnabled({ ...chrome, title: 'Do not store metadata' }, true);
  prefs.setMediaAppEnabled(player, false);
  ({ prefs } = store(settings));
  prefs.rememberMediaApps([{ ...player, appName: 'Renamed player' }, chrome]);
  assert.equal(prefs.isMediaAppEnabled(chrome.packageName), true);
  assert.equal(prefs.isMediaAppEnabled(player.packageName), false);
  assert.equal(prefs.readMediaApps().find((a) => a.packageName === player.packageName).appName, 'Renamed player');
  assert.ok(!Array.from(settings.values()).join('').includes('Do not store metadata'));
  prefs.rememberMediaApps([]);
  assert.equal(prefs.readMediaApps().length, 2);
  prefs.setMediaAppEnabled(player, true);
  prefs.setMediaAppEnabled(chrome, false);
  assert.equal(store(settings).prefs.isMediaAppEnabled(player.packageName), true);
  assert.equal(store(settings).prefs.isMediaAppEnabled(chrome.packageName), false);
});

test('malformed saved entries preserve defaults, and discovery does not freeze defaults', () => {
  for (const raw of ['invalid', '{}', '[null, {}, {"packageName": 1}]',
    '[{"packageName":"com.android.chrome","enabled":"true"}]']) {
    const { prefs } = store(new Map([['music.apps', raw]]));
    assert.equal(prefs.isMediaAppEnabled(chrome.packageName), false);
    assert.equal(prefs.isMediaAppEnabled(player.packageName), true);
  }
  const { prefs } = store();
  prefs.rememberMediaApps([chrome]);
  assert.equal(prefs.readMediaApps()[0].enabled, undefined);
});

function bridges() {
  const { prefs, storage } = store();
  let browserListener, controllerListener, ignored, queries = 0, disconnects = 0, plays = 0;
  const browsable = [chrome, player].map((app) => ({ ...app, serviceClass: `${app.packageName}.Browser` }));
  class NativeBrowser {
    setListener(listener) { browserListener = listener; }
    listBrowsableAppsJson() { queries++; return JSON.stringify(browsable); }
    connect(id) { browserListener.onConnectResult(id, true, 'root', ''); }
    disconnect() { disconnects++; }
    playFromMediaId() { plays++; }
  }
  class NativeController {
    setIgnoredPackagesJson(json) { ignored = JSON.parse(json); }
    setListener(listener) { controllerListener = listener; }
    start() { assert.ok(ignored.includes(chrome.packageName)); }
  }
  const dependencies = {
    '@nativescript/core': { Utils: { android: { getApplicationContext: () => ({}) } } },
    './media-apps': prefs,
    './settings-store': storage,
    '../graphics/image': {},
    './image-files': {},
  };
  const globals = { global: { isAndroid: true }, com: { faceclaw: { app: {
    FaceclawMediaBrowser: NativeBrowser,
    FaceclawMediaBrowserListener: function(listener) { return listener; },
    FaceclawMediaController: NativeController,
    FaceclawMediaControllerListener: function(listener) { return listener; },
  } } } };
  const requireModule = (name) => { assert.ok(name in dependencies, name); return dependencies[name]; };
  const browser = load('app/native/media-browser.ts', requireModule, globals).mediaBrowserBridge;
  const controller = load('app/native/media-controller.ts', requireModule, globals).mediaControllerBridge;
  return { prefs, browser, controller, browsable, queries: () => queries, disconnects: () => disconnects,
    plays: () => plays, ignored: () => ignored, observed: (apps) => controllerListener.onSessionAppsChanged(JSON.stringify(apps)) };
}

test('browse discovery remembers ignored apps and cached results reflect toggles immediately', async () => {
  const b = bridges();
  assert.deepEqual(Array.from(b.browser.listBrowsableApps(), (a) => a.packageName), [player.packageName]);
  assert.equal(b.prefs.readMediaApps().length, 2);
  b.prefs.setMediaAppEnabled(chrome, true);
  assert.equal(b.browser.listBrowsableApps().length, 2);
  assert.equal(b.queries(), 1);
  await b.browser.connect(b.browsable[0]);
  b.browser.playFromMediaId('song');
  assert.equal(b.plays(), 1);
  b.prefs.setMediaAppEnabled(chrome, false);
  assert.equal(b.disconnects(), 1);
  b.browser.playFromMediaId('song');
  assert.equal(b.plays(), 1);
  await assert.rejects(b.browser.connect(b.browsable[0]), /ignored/);
  b.prefs.setMediaAppEnabled(player, false);
  assert.equal(b.browser.listBrowsableApps().length, 0);
});

test('native controller gets defaults before start and records all session owners, retaining ended sessions', async () => {
  const b = bridges();
  await b.controller.start();
  b.observed([chrome, player]);
  b.observed([]);
  assert.equal(b.prefs.readMediaApps().length, 2);
  b.prefs.setMediaAppEnabled(chrome, true);
  b.prefs.setMediaAppEnabled(player, false);
  assert.ok(!b.ignored().includes(chrome.packageName));
  assert.ok(b.ignored().includes(player.packageName));
});

test('Music settings keeps toggles and selection when a new app arrives and supports back', async () => {
  const { prefs } = store();
  let refreshes = 0, closes = 0;
  const textwrap = load('app/graphics/textwrap.ts');
  const graphics = require('../.test-build/app/graphics/image.js');
  const { BdfFont } = load('app/graphics/bdffont.ts', () => ({}));
  const font = BdfFont.parse(source('app/fonts/terminus/ter-u20n.bdf'));
  class RecordingImage extends graphics.GrayImage {
    texts = [];
    drawMenuSelection(source, x, y, ...args) {
      this.texts.push(...source.texts.map(t => ({ ...t, x: t.x + x, y: t.y + y })));
      super.drawMenuSelection(source, x, y, ...args);
    }
    drawText(font, x, y, text, value) { this.texts.push({ x, y, text }); super.drawText(font, x, y, text, value); }
  }
  const deps = {
    '../graphics/image': { ...graphics, GrayImage: RecordingImage },
    '../graphics/textwrap': textwrap,
    '../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../util/numeric-util': { clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)) },
    './menu-highlight-motion': require('../.test-build/app/ui/menu-highlight-motion.js'), '../graphics/menu-scroll-list': require('../.test-build/app/graphics/menu-scroll-list.js'), './menu-scroll-motion': require('../.test-build/app/ui/menu-scroll-motion.js'), '../graphics/draw-expression': require('../.test-build/app/graphics/draw-expression.js'),
    './metrics': load('app/ui/metrics.ts'), './gestures': {},
  };
  deps['./menu-core'] = load('app/ui/menu-core.ts', (name) => deps[name]);
  const menu = load('app/ui/menu.ts', (name) => deps[name]);
  const uiDeps = {
    '../../graphics/image': deps['../graphics/image'],
    '../../graphics/textwrap': textwrap,
    '../../graphics/ui-fonts': deps['../graphics/ui-fonts'],
    '../../native/media-apps': prefs,
    '../../native/media-browser': { mediaBrowserBridge: { listBrowsableApps: (refresh) => {
      assert.equal(refresh, true); refreshes++; prefs.rememberMediaApps([player]); return [];
    } } },
    '../../ui/menu': menu,
  };
  const { MusicSettingsLayer } = load('app/apps/music/music-settings.ts', (name) => uiDeps[name]);
  const layer = new MusicSettingsLayer();
  const ctx = { stack: { getBaseSize: () => ({ width: 540, height: 224 }), isFocused: () => true, pop: () => closes++ } };
  const paint = () => layer.paint(ctx, () => new RecordingImage(540, 224));
  const input = (type) => layer.handleInput({ type }, ctx);
  assert.equal(refreshes, 1);
  paint();
  await input('click');
  assert.equal(prefs.isMediaAppEnabled(player.packageName), false);
  prefs.rememberMediaApps([{ packageName: 'com.alpha', appName: 'Alpha' }]);
  const image = paint();
  assert.ok(image.texts.some(({ text }) => text === 'Player'));
  assert.ok(image.texts.some(({ text }) => text === 'Alpha'));
  assert.ok(image.texts.every(({ y }) => y >= 0 && y + font.lineHeight <= image.height));
  await input('click');
  assert.equal(prefs.isMediaAppEnabled(player.packageName), true);
  await input('double-click');
  assert.equal(closes, 1);
});

// FaceclawMediaController is Kotlin compiled by the NativeScript Android build, so
// compile the extracted method with the same Kotlin compiler Gradle already cached.
function kotlinCompiler() {
  const gradle = source('App_Resources/Android/before-plugins.gradle').match(/kotlinVersion\s*=\s*"([^"]+)"/);
  const cache = path.join(os.homedir(), '.gradle/caches/modules-2/files-2.1');
  const jar = (group, artifact, version) => {
    const directory = path.join(cache, group, artifact, version);
    if (!fs.existsSync(directory)) return null;
    for (const hash of fs.readdirSync(directory)) {
      const file = path.join(directory, hash, `${artifact}-${version}.jar`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  };
  const anyVersion = (group, artifact) => {
    const directory = path.join(cache, group, artifact);
    if (!fs.existsSync(directory)) return null;
    for (const version of fs.readdirSync(directory).sort().reverse()) {
      const file = jar(group, artifact, version);
      if (file) return file;
    }
    return null;
  };
  if (!gradle) return null;
  const version = gradle[1];
  const stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', version);
  const compiler = [
    jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', version),
    stdlib,
    jar('org.jetbrains.kotlin', 'kotlin-script-runtime', version),
    jar('org.jetbrains.kotlin', 'kotlin-daemon-embeddable', version),
    anyVersion('org.jetbrains.kotlin', 'kotlin-reflect'),
    anyVersion('org.jetbrains.intellij.deps', 'trove4j'),
    anyVersion('org.jetbrains', 'annotations'),
    anyVersion('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm'),
  ];
  if (compiler.some(file => !file)) return null;
  return { classpath: compiler.join(path.delimiter), stdlib };
}

test('native session selection skips ignored playing and idle apps, including the all-ignored case', (t) => {
  // Execute the production selection method with lightweight media-session doubles.
  const compiler = kotlinCompiler();
  if (!compiler) return t.skip('Kotlin compiler not in the Gradle cache; run ./build.sh once');
  const kotlin = source('App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMediaController.kt');
  const method = kotlin.slice(kotlin.indexOf('    private fun chooseController('),
    kotlin.indexOf('    private fun emitSessionAppsLocked('));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-media-kotlin-'));
  const javaBin = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
  try {
    const file = path.join(directory, 'MediaSelectionTest.kt');
    fs.writeFileSync(file, `
class PlaybackState(val state: Int) { companion object { const val STATE_PLAYING = 3 } }
class MediaController(val packageName: String, state: Int) { var playbackState: PlaybackState? = PlaybackState(state) }
class MediaSelectionTest {
  val ignoredPackages: MutableSet<String> = HashSet()
${method}
  fun run() {
    val ignored = MediaController("browser", 3)
    val paused = MediaController("player", 2)
    val playing = MediaController("music", 3)
    ignoredPackages.add("browser")
    check(chooseController(listOf(ignored, paused)) === paused)
    check(chooseController(listOf(ignored, paused, playing)) === playing)
    check(chooseController(listOf(ignored)) == null)
    ignored.playbackState = null
    check(chooseController(listOf(ignored, paused)) === paused)
    ignoredPackages.add("music")
    check(chooseController(listOf(ignored, paused, playing)) === paused)
    ignoredPackages.remove("browser"); ignored.playbackState = PlaybackState(3)
    check(chooseController(listOf(ignored, paused)) === ignored)
    check(chooseController(null) == null)
    check(chooseController(emptyList()) == null)
  }
}
fun main() { MediaSelectionTest().run() }
`);
    const out = path.join(directory, 'out');
    execFileSync(javaBin, ['-cp', compiler.classpath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
      '-no-stdlib', '-cp', compiler.stdlib, '-d', out, file], { stdio: 'pipe' });
    execFileSync(javaBin, ['-cp', [out, compiler.stdlib].join(path.delimiter), 'MediaSelectionTestKt'], { stdio: 'pipe' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
