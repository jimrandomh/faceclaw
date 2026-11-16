/**
 * Platform-independent half of the SSH transport bindings (ssh.ts /
 * ssh.ios.ts): the types the app uses and the decoding of the Go
 * transport's events (native/ssh/faceclawssh.go, Listener).
 */

/** Where and as whom to connect. */
export type SshEndpoint = {
  host: string;
  port: number;
  user: string;
  /** Pinned host keys (SSH wire format, base64). Empty: first connection reports hostkey-unknown. */
  hostKeys: string[];
  /** Saved password, or "" to try only the device key. */
  password: string;
  /** Offer the device's client key. */
  useKey: boolean;
};

export type SshChannelSpec =
  | {
      /** Run a command on the host; text is exchanged a line at a time. */
      type: "exec";
      command: string;
    }
  | {
      /** WebSocket to a URL resolved on the host's side (e.g. ws://127.0.0.1:8737/). */
      type: "websocket";
      url: string;
    };

export type SshHostKey = {
  /** SSH key type, e.g. "ssh-ed25519". */
  type: string;
  /** OpenSSH-style "SHA256:..." fingerprint. */
  fingerprint: string;
  /** SSH wire format, base64: the value to pin in SshEndpoint.hostKeys. */
  key: string;
};

export type SshFailureKind =
  | "hostkey-unknown"
  | "hostkey-mismatch"
  | "auth"
  | "network"
  | "channel"
  | "config"
  | "internal";

export type SshFailure = {
  kind: SshFailureKind;
  message: string;
  /** For hostkey-*: the key the host presented. */
  hostKey?: SshHostKey;
  /** For auth: the host takes passwords / we sent one / we offered our key. */
  passwordAllowed?: boolean;
  passwordTried?: boolean;
  keyTried?: boolean;
};

export type SshClosed = {
  /** Exec channels: the command's exit status (and signal, if killed). */
  exitStatus?: number;
  signal?: string;
  /** WebSocket channels: the close frame's code and reason. */
  code?: number;
  reason?: string;
};

export type SshChannelListener = {
  onOpen(): void;
  onText(text: string): void;
  onStderr?(line: string): void;
  /** Terminal: the channel ended normally. */
  onClosed(info: SshClosed): void;
  /** Terminal: the channel couldn't open or was lost. */
  onFailure(failure: SshFailure): void;
};

export type SshChannel = {
  /** Queue a websocket text frame / an exec stdin line. False once closed. */
  send(text: string): boolean;
  /** Flush queued sends, then end the channel. No events follow. */
  close(): void;
};

export type SshClientKey = {
  /** "ecdsa-sha2-nistp256 AAAA... comment", for ~/.ssh/authorized_keys. */
  authorizedKey: string;
  fingerprint: string;
};

/** Build the Go transport's openSpec JSON. */
export function encodeSshSpec(endpoint: SshEndpoint, channel: SshChannelSpec): string {
  return JSON.stringify({
    host: endpoint.host,
    port: endpoint.port,
    user: endpoint.user,
    password: endpoint.password,
    hostKeys: endpoint.hostKeys,
    useKey: endpoint.useKey,
    channel,
  });
}

/** Route one transport event to the listener. Unknown kinds are ignored. */
export function dispatchSshEvent(listener: SshChannelListener, kind: string, payload: string): void {
  switch (kind) {
    case "open":
      listener.onOpen();
      return;
    case "text":
      listener.onText(payload);
      return;
    case "stderr":
      listener.onStderr?.(payload);
      return;
    case "closed":
      listener.onClosed(parseJson(payload) ?? {});
      return;
    case "failure": {
      const failure = parseJson(payload);
      listener.onFailure(
        failure && typeof failure.kind === "string"
          ? failure
          : { kind: "internal", message: `bad failure payload: ${payload}` },
      );
      return;
    }
  }
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Human summary of a failure for status lines. */
export function describeSshFailure(failure: SshFailure): string {
  switch (failure.kind) {
    case "hostkey-unknown":
      return "Host key not yet trusted.";
    case "hostkey-mismatch":
      return "HOST KEY CHANGED; refusing to connect.";
    case "auth":
      return failure.message || "Authentication failed.";
    default:
      return failure.message || failure.kind;
  }
}
