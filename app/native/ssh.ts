import { Utils } from "@nativescript/core";
import {
  dispatchSshEvent,
  encodeSshSpec,
  type SshChannel,
  type SshChannelListener,
  type SshChannelSpec,
  type SshClientKey,
  type SshEndpoint,
} from "./ssh-common";

export * from "./ssh-common";

declare const com: any;

/**
 * Android SSH transport: FaceclawSshChannel (Kotlin) over the gomobile-bound
 * Go package in native/ssh. Callable from the main isolate or a worker;
 * events arrive on the calling isolate's thread.
 */
export function openSshChannel(endpoint: SshEndpoint, channel: SshChannelSpec, listener: SshChannelListener): SshChannel {
  let closed = false;
  const proxy = new com.faceclaw.app.FaceclawSshListener({
    onEvent: (kind: string, payload: string) => {
      if (closed) return;
      dispatchSshEvent(listener, String(kind), payload == null ? "" : String(payload));
    },
  });
  const native = new com.faceclaw.app.FaceclawSshChannel(encodeSshSpec(endpoint, channel), endpoint.useKey, proxy);
  return {
    send: (text) => !closed && native.send(text) === true,
    close: () => {
      if (closed) return;
      closed = true;
      native.close();
    },
  };
}

function context(): any {
  return Utils.android.getApplicationContext();
}

/** The device's SSH client key (generated on first use). */
export function sshClientKey(comment: string): SshClientKey {
  return {
    authorizedKey: String(com.faceclaw.app.FaceclawSshKeys.authorizedKey(comment)),
    fingerprint: String(com.faceclaw.app.FaceclawSshKeys.fingerprint()),
  };
}

export function getSshSecret(id: string): string {
  return String(com.faceclaw.app.FaceclawSshKeys.getSecret(context(), id) ?? "");
}

export function setSshSecret(id: string, value: string): void {
  com.faceclaw.app.FaceclawSshKeys.setSecret(context(), id, value);
}

export function removeSshSecret(id: string): void {
  com.faceclaw.app.FaceclawSshKeys.removeSecret(context(), id);
}

export function copyToPhoneClipboard(label: string, text: string): void {
  com.faceclaw.app.FaceclawSshKeys.copyToClipboard(context(), label, text);
}
