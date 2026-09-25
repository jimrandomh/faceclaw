import { createListenerPool, type InterfaceAddress } from '../remote/listeners';
declare const FaceclawKitIosRemoteInput: any;
/** The shared Kotlin RemoteInputSession over POSIX sockets; request notifications arrive on the main queue. */
export function remoteNative(onRequestReady: () => void) {
  return createListenerPool(() => {
    const native = FaceclawKitIosRemoteInput.new();
    native.setRequestListenerListener(onRequestReady);
    return { start: (port, address) => String(native.startAddressPortAddress(port, address)), stop: () => { native.setRequestListenerListener(null); native.stop(); },
      nextRequest: () => native.nextRequest(), complete: (id, response) => native.completeIdValue(id, response) };
  });
}
function shared(): any { return FaceclawKitIosRemoteInput.companion.shared; }
export function remoteInterfaces(): InterfaceAddress[] { return JSON.parse(String(shared().interfaces())); }
export function randomTokenSecret(): string { return String(shared().randomSecret()); }
export function tokenHash(value: string): string { return String(shared().tokenDigestValue(value)); }
export function copyRemoteToken(value: string): void { UIPasteboard.generalPasteboard.string = value; }
