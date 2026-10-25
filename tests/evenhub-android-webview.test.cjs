const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loader } = require('./helpers/load-typescript.cjs');

// Loads webview.ts against recording doubles of the Android/Kotlin classes.
function androidWebView({ remoteUrl = '', bridgeError = null } = {}) {
  const calls = [], evaluated = [];
  let listener, attachedCheck;
  const ignore = new Proxy({}, { get: () => () => {} });
  class WebView {
    constructor() { calls.push('construct'); }
    getSettings() { calls.push('settings'); return ignore; }
    setWebViewClient() {} setWebChromeClient() {}
    addJavascriptInterface() { calls.push('addJavascriptInterface'); }
    evaluateJavascript(js) { evaluated.push(js); }
    loadUrl(url) { calls.push(`load ${url}`); }
  }
  const app = {
    FaceclawEvenHubWebView: WebView,
    FaceclawEvenHubProfile: { apply: (web, packageId) => { calls.push(`profile ${packageId}`); return web instanceof WebView; } },
    FaceclawEvenHubListener: class { constructor(impl) { listener = impl; } },
    FaceclawEvenHubJsBridge: {
      originRule: url => /^https?:\/\/[^/]+/.exec(url)[0],
      install: (_web, rule) => { calls.push(`bridge ${rule}`); return bridgeError; },
    },
    FaceclawEvenHubWebViewClient: class {}, FaceclawEvenHubChromeClient: class {},
    FaceclawEvenHubDocumentStart: { install: (_web, _script, rule) => { calls.push(`document-start ${rule}`); return true; } },
    FaceclawEvenHubWebViewHost: { getInstance: () => ({ attach(_activity, _web, check) { attachedCheck = check; }, detach() { calls.push('detach'); } }) },
  };
  const load = loader({ com: { faceclaw: { app } }, android: { content: { MutableContextWrapper: class {} } }, java: {} }, {
    '@nativescript/core': { Application: { android: { foregroundActivity: {} } }, Utils: {} },
    './session': { EVENHUB_BRIDGE_INJECT_SCRIPT: '', buildFaceclawExtensionsScript: () => '' }, '../../version': { FACECLAW_VERSION: 'test' },
  });
  const failures = [];
  const session = { manifest: { packageId: 'com.example.app', entrypoint: 'index.html', name: 'Example' }, distDir: '/dist', remoteUrl,
    webViewFailed: (message, fatal) => failures.push([message, fatal]), webViewLoaded() {}, handleBridgeCall() {} };
  const api = load('app/apps/evenhub/webview.ts');
  const handle = api.createEvenHubWebView(session);
  return { api, calls, evaluated, failures, handle, listener: () => listener, attachedCheck: () => attachedCheck };
}

// Runs a host-evaluated script in a document at `href`, as WebView would.
function runIn(href, script, globals = {}) {
  const context = vm.createContext({ URL, location: new URL(href), JSON, String, ...globals });
  context.window = context;
  return { result: vm.runInContext(script, context), context };
}

test('Android EvenHub WebViews join their package profile, then get an origin-locked bridge', () => {
  const h = androidWebView();
  assert.deepEqual(h.calls, ['construct', 'profile com.example.app', 'settings',
    'bridge https://com.example.app.evenhub.invalid', 'load https://com.example.app.evenhub.invalid/index.html']);
  const remote = androidWebView({ remoteUrl: 'http://192.168.1.5:5173/app/' });
  assert.ok(remote.calls.includes('bridge http://192.168.1.5:5173'));
  assert.ok(remote.calls.includes('document-start http://192.168.1.5:5173'));
});

test('Android EvenHub host scripts only run in the app\'s own documents', () => {
  const h = androidWebView();
  h.handle.evaluateJs('window.ran = true');
  assert.equal(runIn('https://com.example.app.evenhub.invalid/index.html?code=1', h.evaluated[0]).context.ran, true);
  assert.equal(runIn('https://accounts.example.com/authorize', h.evaluated[0]).context.ran, undefined);
  // The ticker's guard is the same check.
  assert.equal(runIn('https://com.example.app.evenhub.invalid/', `if (${h.attachedCheck()}) { 5 }`).result, 5);
  assert.equal(runIn('http://com.example.app.evenhub.invalid/', `if (${h.attachedCheck()}) { 5 }`).result, undefined);
});

test('Android EvenHub transport wraps the bridge port, and is inert without it', () => {
  const posted = [];
  const port = { postMessage: message => posted.push(JSON.parse(message)) };
  const { api } = androidWebView();
  const { context } = runIn('https://com.example.app.evenhub.invalid/', api.ANDROID_EVENHUB_TRANSPORT_SCRIPT, { __faceclawEvenHubPort: port });
  context.__faceclawEvenHub.postMessage('evenAppMessage', '["{}"]', 7);
  context.__faceclawEvenHub.wakeTimers();
  assert.deepEqual(posted, [['call', 'evenAppMessage', '["{}"]', 7], ['wake']]);
  assert.equal(runIn('https://elsewhere.example/', api.ANDROID_EVENHUB_TRANSPORT_SCRIPT).context.__faceclawEvenHub, undefined);
});

test('Android EvenHub apps fail visibly without a bridge, and stop using a WebView whose renderer is gone', () => {
  const failed = androidWebView({ bridgeError: 'too old' });
  assert.deepEqual(failed.failures, [['too old', true]]);
  assert.ok(!failed.calls.some(call => call.startsWith('load ')));
  const h = androidWebView();
  h.listener().onRenderProcessGone(false);
  assert.equal(h.failures.length, 1); assert.equal(h.failures[0][1], true);
  h.handle.evaluateJs('window.ran = true');
  assert.equal(h.evaluated.length, 0);
});
