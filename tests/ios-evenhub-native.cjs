// Run the production WKWebView host in an isolated simulator app, no glasses.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { loader } = require('./helpers/load-typescript.cjs');
const root = path.resolve(__dirname, '..'), work = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-evenhub-probe-'));
const bundle = path.join(work, 'EvenHubProbe.app'), dist = path.join(bundle, 'dist');
fs.mkdirSync(dist, { recursive: true });
const source = fs.readFileSync(path.join(root, 'app/apps/evenhub/session.ts'), 'utf8');
const shim = source.match(/export const EVENHUB_BRIDGE_INJECT_SCRIPT = `([\s\S]*?)`;/)[1];
const adapter = loader({}, { './session': {}, '../../version': {} })('app/apps/evenhub/webview.ios.ts').IOS_EVENHUB_TRANSPORT_SCRIPT;
fs.writeFileSync(path.join(bundle, 'bridge.js'), adapter + shim);
fs.writeFileSync(path.join(bundle, 'secret.txt'), 'must not be served');
fs.writeFileSync(path.join(dist, 'index.html'), `<script>flutter_inappwebview.callHandler('early')</script><script type="module" src="/app.js"></script>`);
fs.writeFileSync(path.join(dist, 'app.js'), `
import { value } from './module.js';
const call = name => flutter_inappwebview.callHandler(name);
if (value === 42) await call('module');
const previous = localStorage.getItem('probe'); localStorage.setItem('probe','saved'); await call(previous === 'saved' ? 'restored' : 'stored');
if ((await (await fetch('/data.json')).json()).ok) await call('fetch');
const image = new Image(); image.onload = () => call('image'); image.src = '/pixel.png';
setTimeout(() => call('timer'), 40); requestAnimationFrame(() => call('raf'));
await WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0])); await call('wasm');
if (!(await fetch('/%2e%2e/secret.txt')).ok) await call('traversal');
`);
fs.writeFileSync(path.join(dist, 'module.js'), 'export const value = 42;');
fs.writeFileSync(path.join(dist, 'data.json'), '{"ok":true}');
fs.writeFileSync(path.join(dist, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBVkAAAAASUVORK5CYII=', 'base64'));
fs.writeFileSync(path.join(bundle, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.faceclaw.evenhub-probe</string><key>CFBundleExecutable</key><string>EvenHubProbe</string><key>CFBundleName</key><string>EvenHubProbe</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1</string><key>UILaunchScreen</key><dict/><key>LSRequiresIPhoneOS</key><true/></dict></plist>`);
const sdk = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim();
execFileSync('xcrun', ['clang', '-fobjc-arc', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-ios15.1-simulator`, '-isysroot', sdk,
  '-framework', 'UIKit', '-framework', 'Foundation', '-framework', 'CoreGraphics', '-framework', 'WebKit', '-framework', 'UniformTypeIdentifiers',
  '-I', 'App_Resources/iOS/src', 'tests/native/ios-evenhub-test.m', 'App_Resources/iOS/src/FaceclawEvenHubWebView.m', '-o', path.join(bundle, 'EvenHubProbe')], { cwd: root, stdio: 'inherit' });
const device = process.argv[2] || 'booted';
execFileSync('xcrun', ['simctl', 'install', device, bundle], { stdio: 'inherit' });
execFileSync('xcrun', ['simctl', 'launch', '--terminate-running-process', device, 'com.faceclaw.evenhub-probe'], { stdio: 'inherit' });
const container = execFileSync('xcrun', ['simctl', 'get_app_container', device, 'com.faceclaw.evenhub-probe', 'data'], { encoding: 'utf8' }).trim();
const resultFile = path.join(container, 'Documents/result.json');
setTimeout(() => {
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  console.log(JSON.stringify({ work, ...result }));
  if (!result.passed) process.exitCode = 1;
}, 14000);
