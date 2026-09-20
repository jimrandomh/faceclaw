import { getStringSetting, setStringSetting, onSettingsStoreChanged } from '../native/settings-store';
import { remoteNative, remoteInterfaces, randomTokenSecret, tokenHash } from '../native/remote-input';
import { INTERFACE_STORAGE_KEY, listenerAddresses } from './listeners';
import { TokenStore, handleRequest, REMOTE_PORT, type RemoteHost } from './protocol';
export const TOKEN_STORAGE_KEY = 'remoteInput.tokens.v1';
export const remoteTokens = new TokenStore(() => getStringSetting(TOKEN_STORAGE_KEY, '[]'),
  value => setStringSetting(TOKEN_STORAGE_KEY, value), randomTokenSecret, tokenHash);
let status = 'No tokens; listener stopped.';
export function remoteInputStatus(): string { return status; }
export function remoteInterfaceSelection(): string { return getStringSetting(INTERFACE_STORAGE_KEY, 'tailscale'); }
export function selectRemoteInterface(value: string): void { setStringSetting(INTERFACE_STORAGE_KEY, value); }

/** Owned by the main controller. Native socket work never enters a JS isolate. */
export function startRemoteInput(host: RemoteHost): () => void {
  const native = remoteNative();
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  let networkTimer: ReturnType<typeof setInterval> | null = null;
  const sync = () => {
    if (!remoteTokens.list().length) {
      native.stop();
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (networkTimer !== null) clearInterval(networkTimer);
      networkTimer = null;
      status = 'No tokens; listener stopped.';
      return;
    }
    const selection = remoteInterfaceSelection();
    const addresses = listenerAddresses(remoteInterfaces(), selection);
    const failure = native.start(REMOTE_PORT, addresses);
    status = `Listening on ${native.addresses().map(address => `${address.includes(':') ? `[${address}]` : address}:${REMOTE_PORT}`).join(', ') || 'no addresses'}.`;
    if (selection !== 'localhost' && addresses.length === 1) status += '\nSelected tunnel not found; localhost only. Enable Tailscale or select its tunnel interface.';
    if (failure) status += `\n${failure}`;
    // Reconcile after VPN reconnects/address changes; unchanged sockets stay open.
    if (networkTimer === null) networkTimer = setInterval(sync, 3000);
    if (timer !== null) return;
    timer = setInterval(() => {
      if (busy) return;
      const raw = native.nextRequest();
      if (!raw) return;
      const request = JSON.parse(String(raw));
      if (Date.now() >= request.expiresAt) return;
      busy = true;
      void handleRequest(request.body, remoteTokens, host)
        .then(reply => native.complete(request.id, JSON.stringify(reply)))
        .catch(() => native.complete(request.id, JSON.stringify({ ok: false, error: 'failed', message: 'Request failed.' })))
        .finally(() => { busy = false; });
    }, 15);
  };
  sync();
  const off = onSettingsStoreChanged(key => { if (key === TOKEN_STORAGE_KEY || key === INTERFACE_STORAGE_KEY) sync(); });
  return () => { off(); if (timer !== null) clearInterval(timer); if (networkTimer !== null) clearInterval(networkTimer); native.stop(); };
}
