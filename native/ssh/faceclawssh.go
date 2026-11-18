// Package faceclawssh is Faceclaw's SSH transport, bound into the Android and
// iOS apps with gomobile. It exposes text-message channels over SSH:
//
//   - "exec": run a command on the host and exchange newline-delimited text
//     with it (stdin lines in, stdout lines out). Used for tmux control mode
//     and the tmux session poller.
//   - "websocket": open a direct-tcpip channel to an address as seen from the
//     host (normally g2mirror-server on 127.0.0.1:8737) and speak WebSocket
//     text frames over it.
//
// Channels to the same host, user and credentials share one SSH connection
// (see pool.go). Host keys are pinned by the caller: a connection whose host
// presents a key that isn't in the spec's hostKeys fails with a
// "hostkey-unknown" or "hostkey-mismatch" failure carrying the presented key,
// so the app can show the fingerprint and retry once the user has trusted it.
// Authentication uses a platform-held, non-exportable ECDSA P-256 key (the
// Signer interface; Android Keystore / iOS Secure Enclave) and, if the server
// allows it, a password.
//
// Everything crossing the gomobile boundary is a string, []byte or one of the
// interfaces below; structured values are JSON strings.
package faceclawssh

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime/debug"
	"sync"
	"time"
)

// Signer is implemented by the platform: an ECDSA P-256 key whose private
// half never leaves the device's keystore.
type Signer interface {
	// PublicKey returns the key's public half, either as X.509
	// SubjectPublicKeyInfo DER (Android's PublicKey.getEncoded()) or as an
	// uncompressed X9.62 point, 0x04 || X || Y (iOS's
	// SecKeyCopyExternalRepresentation).
	PublicKey() []byte
	// Sign returns the ASN.1 DER ECDSA signature of SHA-256(data).
	Sign(data []byte) ([]byte, error)
}

// Listener receives a channel's events. Calls arrive on arbitrary goroutines
// (never concurrently for one channel); the platform wrapper hops them onto
// the thread that owns the channel.
//
// Event kinds and payloads:
//   - "open": the channel is ready; payload empty. Sends made before this are
//     queued and delivered once open.
//   - "text": one message (websocket text frame, or one stdout line without
//     its newline). Exec lines that aren't valid UTF-8 have every byte >= 0x80
//     escaped as a backslash and three octal digits, matching tmux control
//     mode's escaping of control characters (see escapeLine).
//   - "stderr": one stderr line of an exec channel, escaped the same way.
//   - "closed": the channel ended normally; payload is JSON
//     {"exitStatus": n, "signal": "...", "code": n, "reason": "..."} with the
//     fields that apply (exec exit status/signal, websocket close code/reason).
//     Terminal: no events follow.
//   - "failure": the channel could not be opened or was lost; payload is a
//     JSON Failure. Terminal: no events follow.
type Listener interface {
	OnEvent(kind string, payload string)
}

// Failure describes why a channel failed, as the JSON payload of a "failure"
// event.
type failure struct {
	// "hostkey-unknown": no host key is pinned yet; HostKey is what the host
	// presented. "hostkey-mismatch": the host presented a key that isn't
	// pinned. "auth": the host refused every credential we have.
	// "network": couldn't reach the host, or the connection dropped.
	// "channel": the SSH connection is fine but the channel couldn't be
	// opened (exec refused, nothing listening at the forwarded address...).
	// "config": the spec was malformed. "internal": a bug.
	Kind    string       `json:"kind"`
	Message string       `json:"message"`
	HostKey *hostKeyInfo `json:"hostKey,omitempty"`
	// For "auth": the host accepts password (or keyboard-interactive)
	// authentication, whether a password was sent, and whether our key was
	// offered.
	PasswordAllowed bool `json:"passwordAllowed,omitempty"`
	PasswordTried   bool `json:"passwordTried,omitempty"`
	KeyTried        bool `json:"keyTried,omitempty"`
}

func (f *failure) Error() string { return f.Message }

type hostKeyInfo struct {
	// SSH key type, e.g. "ssh-ed25519".
	Type string `json:"type"`
	// OpenSSH-style SHA-256 fingerprint, "SHA256:<base64>".
	Fingerprint string `json:"fingerprint"`
	// The key in SSH wire format, base64: what goes in a spec's hostKeys.
	Key string `json:"key"`
}

type channelSpec struct {
	// "exec" or "websocket".
	Type string `json:"type"`
	// exec: the command line, run by the user's login shell.
	Command string `json:"command"`
	// websocket: ws:// URL, resolved on the host's side of the connection.
	URL string `json:"url"`
}

type openSpec struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	Password string `json:"password"`
	// Pinned host keys, SSH wire format, base64. Empty: the first connection
	// fails with "hostkey-unknown".
	HostKeys []string `json:"hostKeys"`
	// Offer the platform key (the Signer passed to Open).
	UseKey              bool        `json:"useKey"`
	ConnectTimeoutMs    int         `json:"connectTimeoutMs"`
	KeepaliveIntervalMs int         `json:"keepaliveIntervalMs"`
	Channel             channelSpec `json:"channel"`
}

const (
	defaultConnectTimeout    = 15 * time.Second
	defaultKeepaliveInterval = 20 * time.Second
	// Messages queued on a channel before Send starts refusing them.
	sendQueueCapacity = 4096
	// How long Close waits for queued messages to flush and the far end to
	// finish before tearing the channel down.
	closeGracePeriod = 2 * time.Second
)

// Channel is one open (or opening) channel. Methods are safe to call from
// any thread.
type Channel struct {
	listener Listener
	ctx      context.Context
	cancel   context.CancelFunc

	mu     sync.Mutex
	closed bool // Close was called: no more sends, no more events
	opened bool
	sendQ  chan string

	finishOnce sync.Once
}

// Open starts opening a channel described by spec (a JSON openSpec) and
// returns immediately; progress arrives as listener events. signer may be
// nil (no key authentication).
func Open(spec string, signer Signer, listener Listener) *Channel {
	ctx, cancel := context.WithCancel(context.Background())
	c := &Channel{
		listener: listener,
		ctx:      ctx,
		cancel:   cancel,
		sendQ:    make(chan string, sendQueueCapacity),
	}
	go c.run(spec, signer)
	return c
}

// Send queues one message: a websocket text frame, or a line for an exec
// channel's stdin (the newline is added). Returns false if the channel is
// closed or its queue is full.
func (c *Channel) Send(text string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}
	select {
	case c.sendQ <- text:
		return true
	default:
		return false
	}
}

// Close ends the channel. Messages already queued are still sent (so a
// parting "unview" reaches the host), then the channel's write side is
// closed and, after a short grace period, the channel is torn down. No
// events are delivered after Close.
func (c *Channel) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	opened := c.opened
	close(c.sendQ)
	c.mu.Unlock()
	if !opened {
		c.cancel()
		return
	}
	time.AfterFunc(closeGracePeriod, c.cancel)
}

func (c *Channel) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

func (c *Channel) emit(kind, payload string) {
	if c.isClosed() {
		return
	}
	c.listener.OnEvent(kind, payload)
}

func (c *Channel) markOpen() {
	c.mu.Lock()
	c.opened = true
	c.mu.Unlock()
	c.emit("open", "")
}

// finish delivers the channel's one terminal event ("closed" or "failure").
func (c *Channel) finish(kind string, payload any) {
	c.finishOnce.Do(func() {
		encoded, err := json.Marshal(payload)
		if err != nil {
			encoded = []byte(`{"kind":"internal","message":"unencodable event"}`)
		}
		c.emit(kind, string(encoded))
		c.cancel()
	})
}

func (c *Channel) fail(f *failure) { c.finish("failure", f) }

// guard turns a panic in one of our goroutines into a failure event instead
// of crashing the app (an unrecovered Go panic kills the whole process).
func (c *Channel) guard() {
	if r := recover(); r != nil {
		c.fail(&failure{Kind: "internal", Message: fmt.Sprintf("internal error: %v\n%s", r, debug.Stack())})
	}
}

func (c *Channel) run(specJSON string, signer Signer) {
	defer c.guard()
	var spec openSpec
	if err := json.Unmarshal([]byte(specJSON), &spec); err != nil {
		c.fail(&failure{Kind: "config", Message: "bad channel spec: " + err.Error()})
		return
	}
	if spec.Host == "" || spec.User == "" {
		c.fail(&failure{Kind: "config", Message: "host and user are required"})
		return
	}
	if spec.Port == 0 {
		spec.Port = 22
	}
	if !spec.UseKey {
		signer = nil
	}
	conn, err := acquire(c.ctx, &spec, signer)
	if err != nil {
		if c.ctx.Err() != nil {
			return
		}
		c.fail(asFailure(err))
		return
	}
	defer conn.release()
	switch spec.Channel.Type {
	case "exec":
		c.runExec(conn, spec.Channel.Command)
	case "websocket":
		c.runWebSocket(conn, spec.Channel.URL)
	default:
		c.fail(&failure{Kind: "config", Message: fmt.Sprintf("unknown channel type %q", spec.Channel.Type)})
	}
}

func asFailure(err error) *failure {
	if f, ok := err.(*failure); ok {
		return f
	}
	return &failure{Kind: "network", Message: err.Error()}
}

// AuthorizedKey formats a platform public key (see Signer.PublicKey) as an
// authorized_keys line: "ecdsa-sha2-nistp256 AAAA... comment".
func AuthorizedKey(publicKey []byte, comment string) (string, error) {
	key, err := sshPublicKey(publicKey)
	if err != nil {
		return "", err
	}
	return authorizedKeyLine(key, comment), nil
}

// Fingerprint returns the OpenSSH SHA-256 fingerprint ("SHA256:...") of a
// platform public key.
func Fingerprint(publicKey []byte) (string, error) {
	key, err := sshPublicKey(publicKey)
	if err != nil {
		return "", err
	}
	return fingerprint(key), nil
}
