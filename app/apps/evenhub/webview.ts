/**
 * Constructs the Android WebView that runs one EvenHub app and attaches it to
 * the persistent keep-alive host (FaceclawEvenHubWebViewHost), decoupled from
 * any phone Page. The WebView is created at launch and lives until the app's
 * glasses window closes — it renders the app to the glasses whether or not the
 * phone is currently showing it (see the host for the off-screen-render trick).
 *
 * A raw WebView subclass (FaceclawEvenHubWebView, not the NativeScript
 * component) is used so we fully own the WebViewClient (offline asset serving
 * from a fake per-app origin plus document-start injection of the
 * flutter_inappwebview bridge shim) and so the page keeps running JS while the
 * host app is backgrounded (see FaceclawEvenHubWebView / the host).
 *
 * A session with a remoteUrl (the Developer app's "Load app from URL") skips
 * the offline serving entirely and loads that URL from the network; the shim
 * is registered as a document-start script instead of being spliced into the
 * served HTML.
 *
 * The app can navigate its WebView to other sites, so host access is tied to
 * the app's origin: the bridge port is injected only into the app's own frames
 * (FaceclawEvenHubJsBridge), and every script the host runs in the WebView is
 * guarded by an origin check.
 */
import { Application, Utils } from "@nativescript/core";
import { EVENHUB_BRIDGE_INJECT_SCRIPT, buildFaceclawExtensionsScript, type EvenHubSession } from "./session";
import { FACECLAW_VERSION } from "../../version";

declare const android: any;
declare const com: any;
declare const java: any;

export type EvenHubWebView = {
  evaluateJs: (js: string) => void;
  destroy: () => void;
  /** Show the app's phone UI; `onClose` runs when its top bar's close button is tapped. */
  showOnPhone: (onClose: () => void) => void;
  hideOnPhone: () => void;
  /** The native android.webkit.WebView, for the host. */
  native: unknown;
};

/**
 * Wraps the bridge port (window.__faceclawEvenHubPort, which WebView injects
 * only into the app's own frames) as the window.__faceclawEvenHub interface
 * the bridge shim and the extensions call.
 */
export const ANDROID_EVENHUB_TRANSPORT_SCRIPT = `
(function () {
  var port = window.__faceclawEvenHubPort;
  if (!port || window.__faceclawEvenHub) return;
  window.__faceclawEvenHub = {
    postMessage: function (name, args, id) { port.postMessage(JSON.stringify(['call', String(name), String(args), id])); },
    wakeTimers: function () { port.postMessage('["wake"]'); }
  };
})();
`;

/** A JS expression that is true only in a document from `startUrl`'s origin. */
export function appOriginCheck(startUrl: string): string {
  return `(function (app) { return app.protocol === location.protocol && app.host === location.host; })(new URL(${JSON.stringify(startUrl)}))`;
}

/** `js`, run only when the WebView's document is from `startUrl`'s origin. */
export function guardToAppOrigin(startUrl: string, js: string): string {
  return `if (${appOriginCheck(startUrl)}) {\n${js}\n}`;
}

/**
 * A distinct (fake, intercepted) https origin per app. The per-app profile is
 * what keeps storage apart; without one, this still separates origin-scoped
 * storage, though not cookies scoped to the shared evenhub.invalid domain.
 */
function originHost(session: EvenHubSession): string {
  const safe = session.manifest.packageId.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
  return `${safe}.evenhub.invalid`;
}

/**
 * Build the app's WebView, wire it to the session, attach it to the keep-alive
 * host, and start loading. Must run on the main thread.
 */
export function createEvenHubWebView(session: EvenHubSession): EvenHubWebView {
  const activity = Application.android?.foregroundActivity ?? Application.android?.startActivity;
  const context = activity ?? Utils.android.getApplicationContext();
  // A mutable wrapper, so the host can re-point the WebView at a recreated
  // activity (see FaceclawEvenHubWebViewHost).
  const webView = new com.faceclaw.app.FaceclawEvenHubWebView(new android.content.MutableContextWrapper(context));
  // The app's own WebView profile, so its browser storage (and that of sites it
  // navigates to) is separate from every other app's. This must come before
  // any other use of the WebView.
  if (!com.faceclaw.app.FaceclawEvenHubProfile.apply(webView, session.manifest.packageId)) {
    console.warn(`evenhub: this WebView can't separate profiles; ${session.manifest.packageId} shares browser storage with other apps`);
  }
  const settings = webView.getSettings();
  settings.setJavaScriptEnabled(true);
  settings.setDomStorageEnabled(true);
  settings.setAllowFileAccess(false);
  settings.setMediaPlaybackRequiresUserGesture(false);

  // Set once the renderer is gone: the WebView is destroyed and must not be used.
  let gone = false;
  const listener = new com.faceclaw.app.FaceclawEvenHubListener({
    onEvenAppMessage: (handlerName: string, argsJson: string, callId: number) => {
      session.handleBridgeCall(String(handlerName), String(argsJson), Number(callId));
    },
    onPageFinished: () => {
      session.webViewLoaded();
    },
    onRenderProcessGone: (crashed: boolean) => {
      gone = true;
      session.webViewFailed(crashed
        ? "The app's web page crashed. Close and reopen the app."
        : "Android stopped the app's web page to free memory. Close and reopen the app.", true);
    },
  });

  const remoteUrl = session.remoteUrl;
  // Remote apps load from their own server, so nothing is intercepted and the
  // fake per-app origin is unused.
  const host = remoteUrl ? "" : originHost(session);
  const startUrl = remoteUrl || `https://${host}/${session.manifest.entrypoint}`;
  const originRule: string | null = com.faceclaw.app.FaceclawEvenHubJsBridge.originRule(startUrl);
  const appCheck = appOriginCheck(startUrl);
  const guarded = (js: string) => guardToAppOrigin(startUrl, js);
  // The transport, the stock bridge shim, then the Faceclaw extensions global
  // (all at document-start, before any app JS).
  const injectScript = guarded(ANDROID_EVENHUB_TRANSPORT_SCRIPT + EVENHUB_BRIDGE_INJECT_SCRIPT +
    buildFaceclawExtensionsScript(`Faceclaw/${FACECLAW_VERSION}`));
  const bridgeError: string | null = originRule
    ? com.faceclaw.app.FaceclawEvenHubJsBridge.install(webView, originRule, listener)
    : `Not a web address: ${startUrl}`;
  const documentStartInstalled = remoteUrl && originRule
    ? com.faceclaw.app.FaceclawEvenHubDocumentStart.install(webView, injectScript, originRule) === true
    : false;
  webView.setWebViewClient(
    new com.faceclaw.app.FaceclawEvenHubWebViewClient(
      session.distDir,
      host,
      injectScript,
      // onPageStarted injection is the fallback when the document-start API
      // is unavailable; packaged apps get the shim spliced into their HTML.
      !!remoteUrl && !documentStartInstalled,
      listener,
    ),
  );

  // Surface the app's console in logcat (tag FaceclawEvenHubConsole).
  webView.setWebChromeClient(new com.faceclaw.app.FaceclawEvenHubChromeClient());

  const nativeHost = com.faceclaw.app.FaceclawEvenHubWebViewHost.getInstance();
  nativeHost.attach(activity, webView, appCheck);
  // Without the bridge the app could only hang waiting for it.
  if (bridgeError) session.webViewFailed(String(bridgeError), true);
  else webView.loadUrl(startUrl);

  return {
    native: webView,
    evaluateJs: (js: string) => {
      if (gone) return;
      try {
        webView.evaluateJavascript(guarded(js), null);
      } catch (error) {
        console.warn(`evenhub evaluateJs failed: ${error}`);
      }
    },
    destroy: () => {
      try {
        nativeHost.detach(webView);
      } catch (error) {
        console.warn(`evenhub webview destroy failed: ${error}`);
      }
    },
    showOnPhone: (onClose: () => void) =>
      nativeHost.showOnPhone(
        Application.android?.foregroundActivity ?? Application.android?.startActivity ?? null,
        webView,
        session.manifest.name,
        new java.lang.Runnable({ run: onClose }),
      ),
    hideOnPhone: () => nativeHost.hideOnPhone(),
  };
}
