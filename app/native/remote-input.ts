import { createListenerPool, type InterfaceAddress } from '../remote/listeners';
import { Utils } from '@nativescript/core';
declare const com: any;
export function remoteNative() {
  return createListenerPool(() => {
    const native = new com.faceclaw.app.FaceclawRemoteInput();
    return { start: (port, address) => String(native.startAddress(port, address)), stop: () => native.stop(),
      nextRequest: () => native.nextRequest(), complete: (id, response) => native.complete(id, response) };
  });
}
export function remoteInterfaces(): InterfaceAddress[] { return JSON.parse(String(com.faceclaw.app.FaceclawRemoteInput.interfaces())); }
export function randomTokenSecret(): string { return String(com.faceclaw.app.FaceclawRemoteInput.getInstance().randomSecret()); }
export function tokenHash(value: string): string { return String(com.faceclaw.app.FaceclawRemoteInput.getInstance().hash(value)); }
export function copyRemoteToken(value: string): void {
  const context = Utils.android.getApplicationContext();
  context.getSystemService('clipboard').setPrimaryClip(android.content.ClipData.newPlainText('Faceclaw input token', value));
}
