// Run the production Android EvenHub WebView classes in an isolated probe APK on
// an emulator or device, no glasses: node tests/android-evenhub-native.cjs [adb-serial]
// Checks the per-package profiles, the origin-locked bridge and the renderer-crash
// handling against a real WebView. Needs ANDROID_HOME, a JDK, and a prior ./build.sh
// (for the cached Kotlin compiler and AndroidX artifacts).
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { loader } = require('./helpers/load-typescript.cjs');
const { newestArtifact, kotlinCompiler } = require('./helpers/kotlin-compiler.cjs');

const root = path.resolve(__dirname, '..');
const sdk = process.env.ANDROID_HOME || path.join(os.homedir(), 'Library/Android/sdk');
const newest = dir => fs.readdirSync(dir).filter(name => /^\d/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
const buildTools = path.join(sdk, 'build-tools', newest(path.join(sdk, 'build-tools')));
const androidJar = path.join(sdk, 'platforms', fs.readdirSync(path.join(sdk, 'platforms')).filter(name => /^android-\d+$/.test(name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1), 'android.jar');
const javaBin = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : '';
const env = { ...process.env, PATH: [javaBin, process.env.PATH].filter(Boolean).join(path.delimiter) };
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
const serial = process.argv[2] || run('adb', ['devices']).split('\n').slice(1).map(line => line.split('\t')).find(([, state]) => state === 'device')?.[0];
if (!serial) throw new Error('No adb device or emulator is attached.');
const adb = (...args) => run('adb', ['-s', serial, ...args]);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-android-evenhub-probe-'));

// The scripts webview.ts builds, from the production sources.
const session = fs.readFileSync(path.join(root, 'app/apps/evenhub/session.ts'), 'utf8');
const shim = session.match(/export const EVENHUB_BRIDGE_INJECT_SCRIPT = `([\s\S]*?)`;/)[1];
const webview = loader({}, { '@nativescript/core': {}, './session': {}, '../../version': {} })('app/apps/evenhub/webview.ts');

const reports = [];
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://probe');
  const page = body => { response.setHeader('Content-Type', 'text/html'); response.end(`<!doctype html><html><head></head><body>${body}</body></html>`); };
  if (url.pathname === '/report') { reports.push(url.search.slice(1)); response.end(); return; }
  if (url.pathname === '/cookie') { reports.push(`cookie:${url.searchParams.get('app')}=${/\bthird=A\b/.test(request.headers.cookie ?? '')}`); page('cookie'); return; }
  // A cross-origin iframe inside the app, and a third-party page the app navigates to.
  if (url.pathname === '/xframe') { page(`<script>new Image().src = '/report?xframe=' + typeof window.__faceclawEvenHubPort + ',' + typeof window.__faceclawEvenHub</script>`); return; }
  if (url.pathname === '/third') {
    page(`<script>
      var port = window.__faceclawEvenHubPort;
      new Image().src = '/report?third=' + typeof port + ',' + typeof window.__faceclawEvenHub + ',' + typeof window.flutter_inappwebview;
      if (port) port.postMessage(JSON.stringify(['call', 'probe', '["UNTRUSTED"]', 0]));
      document.cookie = 'third=A; max-age=3600';
      window.__fcTick = function () { new Image().src = '/report?tick=leak'; return 16; };
    </script>`);
    return;
  }
  if (url.pathname === '/remote/') { page(`<script>flutter_inappwebview.callHandler('probe', 'remote')</script>`); return; }
  response.writeHead(404); response.end();
});

server.listen(0, '127.0.0.1', async () => {
  try {
    const port = server.address().port;
    adb('reverse', `tcp:${port}`, `tcp:${port}`);
    const third = `http://127.0.0.1:${port}`;
    const start = { A: 'https://probe.a.evenhub.invalid/index.html', B: 'https://probe.b.evenhub.invalid/index.html',
      A2: 'https://probe.a.evenhub.invalid/index.html', R: `http://localhost:${port}/remote/` };
    const assets = path.join(work, 'assets'), dist = path.join(assets, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    const checks = {};
    for (const [tag, url] of Object.entries(start)) {
      checks[tag] = webview.appOriginCheck(url);
      fs.writeFileSync(path.join(assets, `inject-${tag}.js`), webview.guardToAppOrigin(url, webview.ANDROID_EVENHUB_TRANSPORT_SCRIPT + shim));
    }
    fs.writeFileSync(path.join(assets, 'config.json'), JSON.stringify({ third, start, checks }));
    fs.writeFileSync(path.join(dist, 'index.html'), `<!doctype html><html><head><title>probe</title></head><body><script>
      var call = function (name) { return flutter_inappwebview.callHandler('probe', name); };
      call('early').then(function () { return call('resolved'); });
      var same = document.createElement('iframe'); same.src = '/frame.html'; document.body.appendChild(same);
      var cross = document.createElement('iframe'); cross.src = '${third}/xframe'; document.body.appendChild(cross);
    </script></body></html>`);
    // The app's own subframe: it gets the port, but the host ignores subframes.
    fs.writeFileSync(path.join(dist, 'frame.html'), `<!doctype html><html><head></head><body><script>
      new Image().src = '${third}/report?sameframe=' + typeof window.__faceclawEvenHubPort;
      flutter_inappwebview.callHandler('probe', 'FRAME');
    </script></body></html>`);

    // Link the manifest, assets and androidx.core's resources (generating its R
    // class, as Gradle would), compile the production classes with the probe,
    // then dex, package and sign.
    const compiler = kotlinCompiler();
    if (!compiler) throw new Error('Kotlin compiler not in the Gradle cache; run ./build.sh once.');
    const aar = (group, artifact) => {
      const file = newestArtifact(group, artifact, 'aar');
      if (!file) throw new Error(`${group}:${artifact} not in the Gradle cache; run ./build.sh once.`);
      const out = path.join(work, artifact);
      run('unzip', ['-q', '-o', file, 'classes.jar', 'res/*', '-d', out]);
      return out;
    };
    const webkit = aar('androidx.webkit', 'webkit'), core = aar('androidx.core', 'core');
    const libraries = [path.join(webkit, 'classes.jar'), path.join(core, 'classes.jar'),
      newestArtifact('androidx.collection', 'collection-jvm'), newestArtifact('androidx.annotation', 'annotation-jvm'),
      newestArtifact('org.jspecify', 'jspecify')];
    if (libraries.some(file => !file)) throw new Error('AndroidX artifacts missing from the Gradle cache; run ./build.sh once.');
    fs.writeFileSync(path.join(work, 'AndroidManifest.xml'), `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.faceclaw.evenhubprobe">
  <uses-permission android:name="android.permission.INTERNET"/>
  <application android:label="EvenHubProbe" android:usesCleartextTraffic="true">
    <activity android:name=".ProbeActivity" android:exported="true"/>
  </application>
</manifest>`);
    const aapt2 = path.join(buildTools, 'aapt2'), coreResources = path.join(work, 'core-res.zip'), generated = path.join(work, 'gen');
    run(aapt2, ['compile', '--dir', path.join(core, 'res'), '-o', coreResources]);
    const unsigned = path.join(work, 'unsigned.apk'), aligned = path.join(work, 'aligned.apk'), signed = path.join(work, 'probe.apk');
    run(aapt2, ['link', '-o', unsigned, '-I', androidJar, '--manifest', path.join(work, 'AndroidManifest.xml'), '-A', assets,
      '-R', coreResources, '--auto-add-overlay', '--extra-packages', 'androidx.core', '--java', generated,
      '--min-sdk-version', '24', '--target-sdk-version', '35']);
    const app = 'App_Resources/Android/src/main/java/com/faceclaw/app';
    const shared = 'native/kotlin/shared/src/commonMain/kotlin/com/faceclaw/app';
    fs.writeFileSync(path.join(work, 'Platform.kt'), 'package com.faceclaw.app\n' +
      'fun fileExists(path: String): Boolean = java.io.File(path).exists()\n' +
      'internal fun readFileData(path: String): ByteArray = java.io.File(path).readBytes()\n');
    const classes = path.join(work, 'classes');
    run('java', ['-cp', compiler.classpath, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-nowarn',
      '-cp', [androidJar, ...libraries, compiler.stdlib].join(path.delimiter), '-d', classes,
      ...['WebView', 'WebViewClient', 'WebViewHost', 'JsBridge', 'Profile', 'DocumentStart', 'ChromeClient'].map(name => `${app}/FaceclawEvenHub${name}.kt`),
      `${shared}/callbacks/FaceclawEvenHubListener.kt`, `${shared}/evenhub/EvenHubAssetServer.kt`,
      path.join(work, 'Platform.kt'), 'tests/native/AndroidEvenHubProbe.kt'], { maxBuffer: 64 << 20 });
    const rSources = run('find', [generated, '-name', 'R.java']).trim().split('\n');
    run('javac', ['-nowarn', '-cp', androidJar, '-d', classes, ...rSources]);
    const dex = path.join(work, 'dex');
    fs.mkdirSync(dex);
    run('jar', ['cf', path.join(work, 'probe.jar'), '-C', classes, '.']);
    run(path.join(buildTools, 'd8'), ['--min-api', '24', '--lib', androidJar, '--output', dex,
      path.join(work, 'probe.jar'), compiler.stdlib, ...libraries], { maxBuffer: 64 << 20 });
    run('zip', ['-j', unsigned, ...fs.readdirSync(dex).map(name => path.join(dex, name))]);
    run(path.join(buildTools, 'zipalign'), ['-p', '-f', '4', unsigned, aligned]);
    run(path.join(buildTools, 'apksigner'), ['sign', '--ks', path.join(os.homedir(), '.android/debug.keystore'), '--ks-pass', 'pass:android',
      '--key-pass', 'pass:android', '--ks-key-alias', 'androiddebugkey', '--out', signed, aligned]);

    try { adb('uninstall', 'com.faceclaw.evenhubprobe'); } catch { /* not installed */ }
    adb('install', '-t', signed);
    adb('logcat', '-c');
    adb('shell', 'am', 'start', '-W', '-n', 'com.faceclaw.evenhubprobe/.ProbeActivity');
    let result = null;
    const deadline = Date.now() + 40000;
    while (!result) {
      if (Date.now() > deadline) throw new Error(`Probe timed out (did the process die?); artifacts: ${work}\n${adb('logcat', '-d', '-b', 'crash')}`);
      await new Promise(resolve => setTimeout(resolve, 500));
      const line = adb('logcat', '-d', '-s', 'EHPROBE:I').split('\n').find(text => text.includes('RESULT '));
      if (line) result = JSON.parse(line.slice(line.indexOf('RESULT ') + 7));
    }
    const seen = new Set(result.seen);
    const alive = adb('shell', 'pidof', 'com.faceclaw.evenhubprobe').trim() !== '';
    const failures = [];
    const expect = (ok, what) => { if (!ok) failures.push(what); };
    for (const tag of Object.keys(start)) expect(seen.has(`${tag}:profile=true`), `${tag} has its own profile`);
    for (const name of ['A:early', 'A:resolved', 'B:early', 'A2:early', 'R:remote']) expect(seen.has(name), `bridge round trip ${name}`);
    expect(![...seen].some(name => name.endsWith(':bridge-error')), 'bridge installs');
    expect(!seen.has('A:FRAME'), 'the app\'s subframe is ignored');
    expect(!seen.has('A:UNTRUSTED'), 'the third-party page cannot post to the host');
    expect(reports.includes('third=undefined,undefined,undefined'), 'the third-party page gets no port, bridge or shim');
    expect(reports.length && reports.filter(r => r.startsWith('xframe=')).every(r => r === 'xframe=undefined,undefined'), 'cross-origin iframes get no port or bridge');
    expect(!reports.includes('eval=leak'), 'host scripts do not run in the third-party page');
    expect(!reports.includes('tick=leak'), 'host ticks do not run in the third-party page');
    expect(reports.includes('cookie:B=false'), 'another package cannot see A\'s third-party cookie');
    expect(reports.includes('cookie:A2=true'), 'A\'s profile keeps its cookie');
    expect(seen.has('R:gone'), 'the crashed renderer is reported');
    expect(alive, 'the process survives the renderer crash');
    console.log(JSON.stringify({ work, serial, seen: [...seen], reports, alive, failures }));
    if (failures.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.stderr?.toString() || '', error); process.exitCode = 1;
  } finally {
    try { adb('reverse', '--remove-all'); } catch { /* best effort */ }
    server.closeAllConnections(); server.close();
  }
});
