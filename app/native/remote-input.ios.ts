import { createListenerPool, type InterfaceAddress } from '../remote/listeners';
declare const FaceclawRemoteInput: any;
export function remoteNative() {
  return createListenerPool(() => {
    const native = FaceclawRemoteInput.alloc().init();
    return { start: (port, address) => String(native.startAddress(port, address)), stop: () => native.stop(),
      nextRequest: () => native.nextRequest(), complete: (id, response) => native.completeResponse(id, response) };
  });
}
export function remoteInterfaces(): InterfaceAddress[] { return JSON.parse(String(FaceclawRemoteInput.interfaces())); }
export function randomTokenSecret(): string { return String(FaceclawRemoteInput.shared().randomSecret()); }
export function tokenHash(value: string): string { return String(FaceclawRemoteInput.shared().tokenDigest(value)); }
export function copyRemoteToken(value: string): void { UIPasteboard.generalPasteboard.string = value; }
