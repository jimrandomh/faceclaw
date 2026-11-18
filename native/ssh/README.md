# Faceclaw SSH transport

The Terminal app's SSH client: a small Go package over
[golang.org/x/crypto/ssh](https://pkg.go.dev/golang.org/x/crypto/ssh), bound
into the apps with gomobile. It provides text-message channels over SSH:

- **exec**: run a command on the host, exchanging newline-delimited text
  (used for tmux control mode and the tmux session poller; see
  `app/apps/terminal/tmux-client.ts`).
- **websocket**: a WebSocket to an address as seen from the host, through a
  `direct-tcpip` channel (used to tunnel g2mirror-server's protocol).

Channels to the same host and credentials share one SSH connection, with a
keepalive that fails them promptly when the peer silently disappears. Host
keys are pinned by the app (first connection reports the presented key so
the user can verify its fingerprint). Authentication uses a non-exportable
ECDSA P-256 key held by the platform keystore (Android Keystore/StrongBox,
iOS Secure Enclave; see `FaceclawSsh.kt` / `FaceclawSsh.m`) and, if the
server allows it, a password saved encrypted on the phone.

## Building

`scripts/go-ssh-build.cjs` runs `gomobile bind` (pinned in `go.mod`'s tool
block) from the NativeScript before-prepare hook and stages
`faceclaw-ssh.aar` / `Faceclawssh.xcframework` into the local
`@faceclaw/kotlin` plugin. It needs Go 1.26+ on PATH, plus the Android NDK
(Android) or Xcode (iOS); a content stamp skips rebuilds when the Go sources
haven't changed.

## Testing

`go test -race ./...` runs the transport against an in-process SSH server
(host-key pinning, password and keyboard-interactive auth, key auth through
a fake platform signer, exec framing, the websocket tunnel, connection
sharing and loss).

## Keeping it current

x/crypto/ssh is the security boundary against a malicious host or a
man in the middle; update it promptly when advisories appear
(`go get golang.org/x/crypto@latest && go mod tidy`). A Go panic in any
goroutine terminates the app: the package recovers in the goroutines it
owns, but not inside the library's own.
