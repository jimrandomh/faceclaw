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

declare const FaceclawSshChannel: any;
declare const FaceclawSshKeys: any;

// Like socket.ios.ts: Go delivers events on its own threads, so the native
// side queues them and this isolate drains the queue on a timer.
const POLL_INTERVAL_MS = 25;

/** iOS SSH transport: FaceclawSshChannel (ObjC) over the gomobile-bound Go package in native/ssh. */
export function openSshChannel(endpoint: SshEndpoint, channel: SshChannelSpec, listener: SshChannelListener): SshChannel {
  const native = FaceclawSshChannel.alloc().initWithSpecUseKey(encodeSshSpec(endpoint, channel), endpoint.useKey);
  let ended = false;
  const stop = () => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    native.close();
  };
  const timer = setInterval(() => {
    const events = JSON.parse(String(native.takeEvents())) as Array<{ kind: string; payload: string }>;
    for (const event of events) {
      if (ended) break;
      if (event.kind === "closed" || event.kind === "failure") {
        // Terminal events: stop polling, then deliver.
        ended = true;
        clearInterval(timer);
      }
      dispatchSshEvent(listener, event.kind, event.payload);
    }
  }, POLL_INTERVAL_MS);
  return {
    send: (text) => !ended && native.send(text) === true,
    close: stop,
  };
}

export function sshClientKey(comment: string): SshClientKey {
  const authorizedKey = FaceclawSshKeys.authorizedKeyWithComment(comment);
  const fingerprint = FaceclawSshKeys.fingerprint();
  if (!authorizedKey || !fingerprint) throw new Error("Could not create the SSH client key.");
  return { authorizedKey: String(authorizedKey), fingerprint: String(fingerprint) };
}

export function getSshSecret(id: string): string {
  return String(FaceclawSshKeys.secretForId(id) ?? "");
}

export function setSshSecret(id: string, value: string): void {
  FaceclawSshKeys.setSecretForId(value, id);
}

export function removeSshSecret(id: string): void {
  FaceclawSshKeys.removeSecretForId(id);
}

export function copyToPhoneClipboard(_label: string, text: string): void {
  FaceclawSshKeys.copyToClipboard(text);
}
