/** Interface selection never returns wildcard, Wi-Fi, cellular or LAN addresses. */
export type InterfaceAddress = { name: string; address: string; pointToPoint: boolean };
export const INTERFACE_STORAGE_KEY = 'remoteInput.interface';
export function isTunnelInterface(item: InterfaceAddress): boolean {
  if (/^(wlan|wifi|wl|en\d|eth\d|rmnet|ccmni|pdp_ip|ap\d|p2p)/i.test(item.name)) return false;
  return item.pointToPoint || /^(tailscale|utun\d|tun\d|wg\d)/i.test(item.name);
}
function isTailnetAddress(address: string): boolean {
  const parts = address.split('.').map(Number);
  return /^fd7a:115c:a1e0:/i.test(address) || (parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}
export function listenerAddresses(interfaces: InterfaceAddress[], selection: string): string[] {
  const addresses = ['127.0.0.1'];
  if (selection === 'localhost') return addresses;
  const tunnels = interfaces.filter(isTunnelInterface);
  // A generic tun/utun name alone does not identify Tailscale. Its dedicated
  // IPv6 prefix does; CGNAT IPv4 alone could belong to an unrelated VPN.
  const tailscaleNames = new Set(tunnels.filter(item => /^tailscale/i.test(item.name) ||
    /^fd7a:115c:a1e0:/i.test(item.address)).map(item => item.name));
  for (const item of tunnels) {
    const selected = selection === 'tailscale'
      ? tailscaleNames.has(item.name) && isTailnetAddress(item.address)
      : selection === `interface:${item.name}`;
    if (selected && item.address !== '0.0.0.0' && item.address !== '::' && !item.address.startsWith('fe80:')) addresses.push(item.address);
  }
  return [...new Set(addresses)].sort();
}

export type NativeListener = {
  start(port: number, address: string): string;
  stop(): void;
  nextRequest(): string | null;
  complete(id: number, response: string): void;
};
/** Independent sockets preserve localhost access while adding/removing a VPN. */
export function createListenerPool(create: () => NativeListener) {
  let nextId = 0, cursor = 0;
  const entries = new Map<string, { id: number; listener: NativeListener }>();
  return {
    start(port: number, addresses: string[]): string {
      for (const [address, entry] of entries) if (!addresses.includes(address)) { entry.listener.stop(); entries.delete(address); }
      const failures: string[] = [];
      for (const address of addresses) if (!entries.has(address)) {
        const listener = create();
        const error = listener.start(port, address);
        if (error) { listener.stop(); failures.push(`${address}: ${error}`); }
        else entries.set(address, { id: ++nextId, listener });
      }
      return failures.join('\n');
    },
    addresses(): string[] { return [...entries.keys()]; },
    stop(): void { for (const entry of entries.values()) entry.listener.stop(); entries.clear(); },
    nextRequest(): string | null {
      const active = [...entries.values()];
      for (let i = 0; i < active.length; i++) {
        const entry = active[cursor++ % active.length];
        const raw = entry.listener.nextRequest();
        if (raw) {
          const request = JSON.parse(String(raw));
          return JSON.stringify({ ...request, id: `${entry.id}/${request.id}` });
        }
      }
      return null;
    },
    complete(id: string, response: string): void {
      const [entryId, requestId] = id.split('/').map(Number);
      for (const entry of entries.values()) if (entry.id === entryId) entry.listener.complete(requestId, response);
    },
  };
}
