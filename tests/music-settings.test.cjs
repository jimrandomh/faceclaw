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
  const graphics = load('app/graphics/image.ts', () => textwrap);
  const { BdfFont } = load('app/graphics/bdffont.ts', () => ({}));
  const font = BdfFont.parse(source('app/fonts/terminus/ter-u20n.bdf'));
  class RecordingImage extends graphics.GrayImage {
    texts = [];
    drawText(font, x, y, text, value) { this.texts.push({ x, y, text }); super.drawText(font, x, y, text, value); }
  }
  const deps = {
    '../graphics/image': { ...graphics, GrayImage: RecordingImage },
    '../graphics/textwrap': textwrap,
    '../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../util/numeric-util': { clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)) },
    './metrics': load('app/ui/metrics.ts'), './gestures': {},
  };
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

test('native session selection skips ignored playing and idle apps, including the all-ignored case', () => {
  // Execute the production selection method with lightweight media-session doubles.
  const java = source('App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMediaController.java');
  const method = java.slice(java.indexOf('    private MediaController chooseController('),
    java.indexOf('    private void emitSessionAppsLocked('));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-media-java-'));
  const javaBin = (name) => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', name) : name;
  try {
    const file = path.join(directory, 'MediaSelectionTest.java');
    fs.writeFileSync(file, `import java.util.*;
public class MediaSelectionTest {
  Set<String> ignoredPackages = new HashSet<>();
  static class PlaybackState {
    static final int STATE_PLAYING = 3;
    int state; PlaybackState(int state) { this.state = state; } int getState() { return state; }
  }
  static class MediaController {
    String name; PlaybackState state;
    MediaController(String name, int state) { this.name = name; this.state = new PlaybackState(state); }
    String getPackageName() { return name; } PlaybackState getPlaybackState() { return state; }
  }
  ${method}
  public static void main(String[] args) {
    MediaSelectionTest test = new MediaSelectionTest();
    MediaController ignored = new MediaController("browser", 3);
    MediaController paused = new MediaController("player", 2);
    MediaController playing = new MediaController("music", 3);
    test.ignoredPackages.add("browser");
    assert test.chooseController(Arrays.asList(ignored, paused)) == paused;
    assert test.chooseController(Arrays.asList(ignored, paused, playing)) == playing;
    assert test.chooseController(Arrays.asList(ignored)) == null;
    ignored.state = null;
    assert test.chooseController(Arrays.asList(ignored, paused)) == paused;
    test.ignoredPackages.add("music");
    assert test.chooseController(Arrays.asList(ignored, paused, playing)) == paused;
    test.ignoredPackages.remove("browser"); ignored.state = new PlaybackState(3);
    assert test.chooseController(Arrays.asList(ignored, paused)) == ignored;
    assert test.chooseController(null) == null;
    assert test.chooseController(Collections.emptyList()) == null;
  }
}`);
    execFileSync(javaBin('javac'), ['-d', directory, file], { stdio: 'pipe' });
    execFileSync(javaBin('java'), ['-ea', '-cp', directory, 'MediaSelectionTest'], { stdio: 'pipe' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
