import { EVENHUB_BRIDGE_INJECT_SCRIPT, buildFaceclawExtensionsScript, type EvenHubSession } from './session'
import { FACECLAW_VERSION } from '../../version'
import type { EvenHubWebView } from './webview'
declare const FaceclawEvenHubWebView: any

export const IOS_EVENHUB_TRANSPORT_SCRIPT = `
window.__faceclawEvenHub = { postMessage: function(name, args, id) {
  window.webkit.messageHandlers.faceclaw.postMessage({kind:'call', name:name, args:args, id:id});
}};
(function() {
  ['log','warn','error'].forEach(function(level) {
    var original = console[level];
    console[level] = function() {
      original.apply(console, arguments);
      window.webkit.messageHandlers.faceclaw.postMessage({kind:'console', message:Array.prototype.map.call(arguments, String).join(' ').slice(0,4000)});
    };
  });
  window.addEventListener('error', function(e) { console.error(e.message); });
  window.addEventListener('unhandledrejection', function(e) { console.error(String(e.reason)); });
})();
`

export function createEvenHubWebView(session: EvenHubSession): EvenHubWebView {
  if (session.remoteUrl) throw new Error('On iOS, open a local .ehpk package from Files.')
  const host = FaceclawEvenHubWebView.new()
  host.packageIdentifier = session.manifest.packageId
  host.eventHandler = (json: string) => {
    try {
      const event = JSON.parse(json)
      if (event.kind === 'call' && typeof event.name === 'string' && typeof event.args === 'string' && Number.isSafeInteger(event.id))
        session.handleBridgeCall(event.name, event.args, event.id)
      else if (event.kind === 'loaded') session.webViewLoaded()
      else if (event.kind === 'error') session.webViewFailed(String(event.message))
      else if (event.kind === 'console') console.log(`[evenhub:${session.manifest.name}] ${event.message}`)
    } catch (error) { console.warn(`EvenHub bridge: ${error}`) }
  }
  // Defer loading until manager.ts has attached the session/window handles.
  const loading = setTimeout(() => host.startEntrypointScript(session.distDir, session.manifest.entrypoint,
    IOS_EVENHUB_TRANSPORT_SCRIPT + EVENHUB_BRIDGE_INJECT_SCRIPT + buildFaceclawExtensionsScript(`Faceclaw/${FACECLAW_VERSION}`)), 0)
  return { native: host, evaluateJs: js => host.evaluate(js),
    destroy: () => { clearTimeout(loading); host.destroy() },
    showOnPhone: () => host.showOnPhone(), hideOnPhone: () => host.hideOnPhone() }
}
