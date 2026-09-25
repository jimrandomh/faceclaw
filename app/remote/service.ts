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

/** Owned by the main controller. Native sockets notify JS only for complete requests. */
export function startRemoteInput(host: RemoteHost): () => void {
  const native = remoteNative(() => { void drain(); });
  let busy = false;
  let stopped = false;
  let networkTimer: ReturnType<typeof setInterval> | null = null;
  // A notification while handling another request is covered by the next drain
  // iteration. No timer or native bridge calls are needed while sockets are idle.
  const drain = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      while (!stopped) {
        const raw = native.nextRequest();
        if (!raw) break;
        const request = JSON.parse(String(raw));
        if (Date.now() >= request.expiresAt) continue;
        let reply;
        try { reply = await handleRequest(request.body, remoteTokens, host); }
        catch { reply = { ok: false, error: 'failed', message: 'Request failed.' }; }
        if (!stopped) native.complete(request.id, JSON.stringify(reply));
      }
    } finally { busy = false; }
  };
  const sync = () => {
    if (!remoteTokens.list().length) {
      native.stop();
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
  };
  sync();
  const off = onSettingsStoreChanged(key => { if (key === TOKEN_STORAGE_KEY || key === INTERFACE_STORAGE_KEY) sync(); });
  return () => { stopped = true; off(); if (networkTimer !== null) clearInterval(networkTimer); native.stop(); };
}
