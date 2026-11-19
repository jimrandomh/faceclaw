package faceclawssh

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSH connections are shared between channels with the same host, port,
// user, credentials and pinned keys: the Terminal app's session poller and
// each of its view windows ride one TCP connection. A connection with no
// channels left lingers briefly (a view window closing and reopening shouldn't
// pay a fresh handshake) and is then closed. A keepalive probe closes
// connections whose peer has silently gone away, which fails every channel on
// them so the app's reconnect logic takes over.

const idleLinger = 15 * time.Second

type pooledConn struct {
	key    string
	client *ssh.Client

	// Guarded by poolMu.
	refs   int
	dead   bool
	linger *time.Timer
}

type dialCall struct {
	done chan struct{}
	err  error
}

var (
	poolMu  sync.Mutex
	pool    = map[string]*pooledConn{}
	dialing = map[string]*dialCall{}
)

func poolKey(spec *openSpec, signer *platformSigner) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%d\x00%s\x00%s\x00", spec.Host, spec.Port, spec.User, spec.Password)
	for _, key := range spec.HostKeys {
		fmt.Fprintf(h, "%s\x00", key)
	}
	if signer != nil {
		h.Write(signer.pub.Marshal())
	}
	fmt.Fprintf(h, "\x00%d", spec.KeepaliveIntervalMs)
	return hex.EncodeToString(h.Sum(nil))
}

// acquire returns a live pooled connection for spec, dialing one if needed
// (concurrent callers for the same key share a single dial). The caller must
// release() it.
func acquire(ctx context.Context, spec *openSpec, signer Signer) (*pooledConn, error) {
	var ps *platformSigner
	if signer != nil {
		var err error
		if ps, err = newPlatformSigner(signer); err != nil {
			return nil, &failure{Kind: "config", Message: "client key unusable: " + err.Error()}
		}
	}
	key := poolKey(spec, ps)
	for {
		poolMu.Lock()
		if conn := pool[key]; conn != nil && !conn.dead {
			conn.refs++
			if conn.linger != nil {
				conn.linger.Stop()
				conn.linger = nil
			}
			poolMu.Unlock()
			return conn, nil
		}
		if call := dialing[key]; call != nil {
			poolMu.Unlock()
			select {
			case <-call.done:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			if call.err != nil {
				return nil, call.err
			}
			continue
		}
		call := &dialCall{done: make(chan struct{})}
		dialing[key] = call
		poolMu.Unlock()

		conn, err := dial(spec, ps, key)
		poolMu.Lock()
		delete(dialing, key)
		if err == nil {
			pool[key] = conn
		}
		call.err = err
		close(call.done)
		poolMu.Unlock()
		if err != nil {
			return nil, err
		}
		// Loop around to take a reference like any other caller.
	}
}

func (conn *pooledConn) release() {
	poolMu.Lock()
	defer poolMu.Unlock()
	conn.refs--
	if conn.refs > 0 || conn.dead {
		return
	}
	conn.linger = time.AfterFunc(idleLinger, func() {
		poolMu.Lock()
		idle := conn.refs == 0 && !conn.dead
		if idle {
			conn.dead = true
			if pool[conn.key] == conn {
				delete(pool, conn.key)
			}
		}
		poolMu.Unlock()
		if idle {
			conn.client.Close()
		}
	})
}

// markDead removes a connection from the pool once its transport has ended,
// so the next acquire dials afresh.
func (conn *pooledConn) markDead() {
	poolMu.Lock()
	defer poolMu.Unlock()
	conn.dead = true
	if conn.linger != nil {
		conn.linger.Stop()
		conn.linger = nil
	}
	if pool[conn.key] == conn {
		delete(pool, conn.key)
	}
}

// hostKeyChecker pins the host key: only keys listed in the spec are
// accepted, and whatever the host presented is kept for the failure report.
type hostKeyChecker struct {
	known     [][]byte
	presented ssh.PublicKey
	rejected  bool
}

func newHostKeyChecker(encoded []string) (*hostKeyChecker, error) {
	checker := &hostKeyChecker{}
	for _, entry := range encoded {
		wire, err := base64.StdEncoding.DecodeString(strings.TrimSpace(entry))
		if err != nil {
			return nil, fmt.Errorf("bad pinned host key: %v", err)
		}
		if _, err := ssh.ParsePublicKey(wire); err != nil {
			return nil, fmt.Errorf("bad pinned host key: %v", err)
		}
		checker.known = append(checker.known, wire)
	}
	return checker, nil
}

func (h *hostKeyChecker) check(_ string, _ net.Addr, key ssh.PublicKey) error {
	h.presented = key
	wire := key.Marshal()
	for _, known := range h.known {
		if bytes.Equal(known, wire) {
			return nil
		}
	}
	h.rejected = true
	return errors.New("host key not trusted")
}

// algorithms lists host key algorithms with the pinned keys' types first, so
// a host with several host keys presents the one we pinned rather than
// whichever the default preference order favors.
func (h *hostKeyChecker) algorithms() []string {
	var preferred []string
	seen := map[string]bool{}
	add := func(algorithm string) {
		if !seen[algorithm] {
			seen[algorithm] = true
			preferred = append(preferred, algorithm)
		}
	}
	for _, wire := range h.known {
		key, err := ssh.ParsePublicKey(wire)
		if err != nil {
			continue
		}
		if key.Type() == ssh.KeyAlgoRSA {
			add(ssh.KeyAlgoRSASHA512)
			add(ssh.KeyAlgoRSASHA256)
			continue
		}
		add(key.Type())
	}
	if len(preferred) == 0 {
		return nil // the library default
	}
	for _, algorithm := range ssh.SupportedAlgorithms().HostKeys {
		add(algorithm)
	}
	return preferred
}

func (h *hostKeyChecker) failure() *failure {
	if h.presented == nil {
		return nil
	}
	info := &hostKeyInfo{
		Type:        h.presented.Type(),
		Fingerprint: fingerprint(h.presented),
		Key:         base64.StdEncoding.EncodeToString(h.presented.Marshal()),
	}
	if len(h.known) == 0 {
		return &failure{Kind: "hostkey-unknown", Message: "Unknown host key " + info.Fingerprint, HostKey: info}
	}
	return &failure{Kind: "hostkey-mismatch", Message: "Host key changed: now " + info.Fingerprint, HostKey: info}
}

// errNoPassword aborts authentication when the host would accept a password
// but we don't have one; the "auth" failure then asks the app to prompt.
var errNoPassword = errors.New("password required")

type authState struct {
	mu              sync.Mutex
	passwordAllowed bool
	passwordTried   bool
	keyTried        bool
}

func (a *authState) set(update func(*authState)) {
	a.mu.Lock()
	update(a)
	a.mu.Unlock()
}

func authMethods(spec *openSpec, signer *platformSigner, state *authState) []ssh.AuthMethod {
	var methods []ssh.AuthMethod
	if signer != nil {
		methods = append(methods, ssh.PublicKeysCallback(func() ([]ssh.Signer, error) {
			state.set(func(a *authState) { a.keyTried = true })
			return []ssh.Signer{signer}, nil
		}))
	}
	password := spec.Password
	methods = append(methods,
		ssh.PasswordCallback(func() (string, error) {
			state.set(func(a *authState) { a.passwordAllowed = true })
			if password == "" {
				return "", errNoPassword
			}
			state.set(func(a *authState) { a.passwordTried = true })
			return password, nil
		}),
		// Many hosts (PAM-backed sshd, e.g. macOS) take passwords through
		// keyboard-interactive. Answer hidden prompts with the password and
		// visible ones with nothing.
		ssh.KeyboardInteractive(func(_, _ string, questions []string, echos []bool) ([]string, error) {
			if len(questions) == 0 {
				return nil, nil
			}
			state.set(func(a *authState) { a.passwordAllowed = true })
			if password == "" {
				return nil, errNoPassword
			}
			state.set(func(a *authState) { a.passwordTried = true })
			answers := make([]string, len(questions))
			for i := range questions {
				if !echos[i] {
					answers[i] = password
				}
			}
			return answers, nil
		}),
	)
	return methods
}

func dial(spec *openSpec, signer *platformSigner, key string) (*pooledConn, error) {
	timeout := defaultConnectTimeout
	if spec.ConnectTimeoutMs > 0 {
		timeout = time.Duration(spec.ConnectTimeoutMs) * time.Millisecond
	}
	checker, err := newHostKeyChecker(spec.HostKeys)
	if err != nil {
		return nil, &failure{Kind: "config", Message: err.Error()}
	}
	addr := net.JoinHostPort(spec.Host, strconv.Itoa(spec.Port))
	dialer := net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
	tcp, err := dialer.Dial("tcp", addr)
	if err != nil {
		return nil, &failure{Kind: "network", Message: describeNetError(err)}
	}
	// Bound the whole handshake, not just the TCP connect.
	tcp.SetDeadline(time.Now().Add(timeout))
	state := &authState{}
	config := &ssh.ClientConfig{
		User:              spec.User,
		Auth:              authMethods(spec, signer, state),
		HostKeyCallback:   checker.check,
		HostKeyAlgorithms: checker.algorithms(),
		ClientVersion:     "SSH-2.0-Faceclaw",
		Timeout:           timeout,
	}
	sshConn, chans, reqs, err := ssh.NewClientConn(tcp, addr, config)
	if err != nil {
		tcp.Close()
		if checker.rejected {
			return nil, checker.failure()
		}
		state.mu.Lock()
		defer state.mu.Unlock()
		if errors.Is(err, errNoPassword) || strings.Contains(err.Error(), "unable to authenticate") {
			message := "The host refused this device's key."
			switch {
			case state.passwordTried:
				message = "The host refused the password."
			case state.passwordAllowed:
				message = "The host wants a password."
			case signer == nil:
				message = "The host accepts neither passwords nor keys we have."
			}
			return nil, &failure{
				Kind:            "auth",
				Message:         message,
				PasswordAllowed: state.passwordAllowed,
				PasswordTried:   state.passwordTried,
				KeyTried:        state.keyTried,
			}
		}
		return nil, &failure{Kind: "network", Message: "SSH handshake failed: " + describeNetError(err)}
	}
	tcp.SetDeadline(time.Time{})
	client := ssh.NewClient(sshConn, chans, reqs)
	conn := &pooledConn{key: key, client: client}
	log.Printf("faceclawssh: connected to %s@%s", spec.User, addr)
	go func() {
		err := client.Wait()
		log.Printf("faceclawssh: connection to %s ended: %v", addr, err)
		conn.markDead()
	}()
	interval := defaultKeepaliveInterval
	if spec.KeepaliveIntervalMs > 0 {
		interval = time.Duration(spec.KeepaliveIntervalMs) * time.Millisecond
	}
	go keepalive(conn, interval)
	return conn, nil
}

// keepalive probes the host every interval and closes the connection if a
// probe goes unanswered for a whole interval, so a dead peer (phone switched
// networks, laptop asleep) fails the channels promptly instead of hanging.
func keepalive(conn *pooledConn, interval time.Duration) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("faceclawssh: keepalive panic: %v", r)
			conn.client.Close()
		}
	}()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		poolMu.Lock()
		dead := conn.dead
		poolMu.Unlock()
		if dead {
			return
		}
		reply := make(chan error, 1)
		go func() {
			_, _, err := conn.client.SendRequest("keepalive@openssh.com", true, nil)
			reply <- err
		}()
		select {
		case err := <-reply:
			if err != nil {
				conn.client.Close()
				return
			}
		case <-time.After(interval):
			log.Printf("faceclawssh: keepalive timed out; closing")
			conn.client.Close()
			return
		}
	}
}

func describeNetError(err error) string {
	message := err.Error()
	// "dial tcp 1.2.3.4:22: connect: connection refused" → keep the tail.
	if index := strings.LastIndex(message, ": "); index >= 0 && strings.HasPrefix(message, "dial ") {
		return message[index+2:]
	}
	return message
}
