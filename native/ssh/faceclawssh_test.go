package faceclawssh

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
)

// ---- test SSH server ----

type testServer struct {
	addr     string
	hostKey  ssh.Signer
	accepts  atomic.Int32
	listener net.Listener
}

type serverOptions struct {
	password            string // "" = password auth disabled
	keyboardInteractive bool   // offer the password via keyboard-interactive instead
	authorizedKey       ssh.PublicKey
}

func newTestServer(t *testing.T, opts serverOptions) *testServer {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	hostKey, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{}
	if opts.password != "" && !opts.keyboardInteractive {
		config.PasswordCallback = func(_ ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			if string(password) == opts.password {
				return nil, nil
			}
			return nil, fmt.Errorf("wrong password")
		}
	}
	if opts.password != "" && opts.keyboardInteractive {
		config.KeyboardInteractiveCallback = func(_ ssh.ConnMetadata, challenge ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
			answers, err := challenge("", "", []string{"Password: "}, []bool{false})
			if err != nil {
				return nil, err
			}
			if len(answers) == 1 && answers[0] == opts.password {
				return nil, nil
			}
			return nil, fmt.Errorf("wrong password")
		}
	}
	if opts.authorizedKey != nil {
		config.PublicKeyCallback = func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if string(key.Marshal()) == string(opts.authorizedKey.Marshal()) {
				return nil, nil
			}
			return nil, fmt.Errorf("unknown key")
		}
	}
	config.AddHostKey(hostKey)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &testServer{addr: listener.Addr().String(), hostKey: hostKey, listener: listener}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			tcp, err := listener.Accept()
			if err != nil {
				return
			}
			server.accepts.Add(1)
			go server.serve(tcp, config)
		}
	}()
	return server
}

func (s *testServer) serve(tcp net.Conn, config *ssh.ServerConfig) {
	conn, chans, reqs, err := ssh.NewServerConn(tcp, config)
	if err != nil {
		tcp.Close()
		return
	}
	defer conn.Close()
	go ssh.DiscardRequests(reqs) // replies false to keepalives, which still counts as alive
	for newChannel := range chans {
		switch newChannel.ChannelType() {
		case "session":
			go serveSession(newChannel)
		case "direct-tcpip":
			go serveDirectTCPIP(newChannel)
		default:
			newChannel.Reject(ssh.UnknownChannelType, "nope")
		}
	}
}

// serveSession implements a few fake commands:
//   - "echo": echo stdin lines back with a "> " prefix until EOF, exit 0
//   - "bytes": print an invalid-UTF-8 line and a stderr line, exit 3
func serveSession(newChannel ssh.NewChannel) {
	channel, requests, err := newChannel.Accept()
	if err != nil {
		return
	}
	defer channel.Close()
	for req := range requests {
		if req.Type != "exec" {
			req.Reply(false, nil)
			continue
		}
		var payload struct{ Command string }
		ssh.Unmarshal(req.Payload, &payload)
		req.Reply(true, nil)
		status := 0
		switch payload.Command {
		case "echo":
			scanner := bufio.NewScanner(channel)
			for scanner.Scan() {
				fmt.Fprintf(channel, "> %s\n", scanner.Text())
			}
		case "bytes":
			channel.Write([]byte("%output %1 caf\xc3\n%output %1 \xa9 ok\nplain ✓\n"))
			channel.Stderr().Write([]byte("oops\n"))
			status = 3
		default:
			channel.Stderr().Write([]byte("unknown command\n"))
			status = 127
		}
		channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{uint32(status)}))
		return
	}
}

func serveDirectTCPIP(newChannel ssh.NewChannel) {
	var target struct {
		Host       string
		Port       uint32
		OriginHost string
		OriginPort uint32
	}
	if err := ssh.Unmarshal(newChannel.ExtraData(), &target); err != nil {
		newChannel.Reject(ssh.ConnectionFailed, "bad payload")
		return
	}
	upstream, err := net.Dial("tcp", net.JoinHostPort(target.Host, fmt.Sprint(target.Port)))
	if err != nil {
		newChannel.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	channel, requests, err := newChannel.Accept()
	if err != nil {
		upstream.Close()
		return
	}
	go ssh.DiscardRequests(requests)
	go func() { io.Copy(upstream, channel); upstream.Close() }()
	io.Copy(channel, upstream)
	channel.Close()
}

// ---- test client plumbing ----

type event struct{ kind, payload string }

type recorder struct {
	events chan event
}

func newRecorder() *recorder { return &recorder{events: make(chan event, 256)} }

func (r *recorder) OnEvent(kind, payload string) { r.events <- event{kind, payload} }

func (r *recorder) next(t *testing.T) event {
	t.Helper()
	select {
	case e := <-r.events:
		return e
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for event")
		return event{}
	}
}

func (r *recorder) expect(t *testing.T, kind string) event {
	t.Helper()
	e := r.next(t)
	if e.kind != kind {
		t.Fatalf("got event %s(%s), want %s", e.kind, e.payload, kind)
	}
	return e
}

func (r *recorder) expectFailure(t *testing.T) failure {
	t.Helper()
	e := r.expect(t, "failure")
	var f failure
	if err := json.Unmarshal([]byte(e.payload), &f); err != nil {
		t.Fatal(err)
	}
	return f
}

type softwareSigner struct{ key *ecdsa.PrivateKey }

func newSoftwareSigner(t *testing.T) *softwareSigner {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &softwareSigner{key: key}
}

func (s *softwareSigner) PublicKey() []byte {
	der, _ := x509.MarshalPKIXPublicKey(&s.key.PublicKey)
	return der
}

func (s *softwareSigner) Sign(data []byte) ([]byte, error) {
	digest := sha256.Sum256(data)
	return ecdsa.SignASN1(rand.Reader, s.key, digest[:])
}

func (s *softwareSigner) sshKey(t *testing.T) ssh.PublicKey {
	key, err := ssh.NewPublicKey(&s.key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func specFor(server *testServer, mutate func(*openSpec)) string {
	host, port, _ := net.SplitHostPort(server.addr)
	var portNumber int
	fmt.Sscan(port, &portNumber)
	spec := openSpec{
		Host:     host,
		Port:     portNumber,
		User:     "jim",
		HostKeys: []string{base64.StdEncoding.EncodeToString(server.hostKey.PublicKey().Marshal())},
		Channel:  channelSpec{Type: "exec", Command: "echo"},
	}
	if mutate != nil {
		mutate(&spec)
	}
	encoded, _ := json.Marshal(spec)
	return string(encoded)
}

func resetPool() {
	poolMu.Lock()
	defer poolMu.Unlock()
	for key, conn := range pool {
		conn.client.Close()
		delete(pool, key)
	}
}

// ---- tests ----

func TestHostKeyPinning(t *testing.T) {
	defer resetPool()
	server := newTestServer(t, serverOptions{password: "pw"})
	wantKey := base64.StdEncoding.EncodeToString(server.hostKey.PublicKey().Marshal())

	rec := newRecorder()
	Open(specFor(server, func(s *openSpec) { s.HostKeys = nil; s.Password = "pw" }), nil, rec)
	f := rec.expectFailure(t)
	if f.Kind != "hostkey-unknown" || f.HostKey == nil || f.HostKey.Key != wantKey ||
		f.HostKey.Type != ssh.KeyAlgoED25519 || !strings.HasPrefix(f.HostKey.Fingerprint, "SHA256:") {
		t.Fatalf("unexpected failure %+v", f)
	}

	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	other, _ := ssh.NewSignerFromKey(otherPriv)
	rec = newRecorder()
	Open(specFor(server, func(s *openSpec) {
		s.HostKeys = []string{base64.StdEncoding.EncodeToString(other.PublicKey().Marshal())}
		s.Password = "pw"
	}), nil, rec)
	f = rec.expectFailure(t)
	if f.Kind != "hostkey-mismatch" || f.HostKey.Key != wantKey {
		t.Fatalf("unexpected failure %+v", f)
	}

	rec = newRecorder()
	ch := Open(specFor(server, func(s *openSpec) { s.Password = "pw" }), nil, rec)
	rec.expect(t, "open")
	ch.Close()
}

func TestPasswordAuth(t *testing.T) {
	for _, interactive := range []bool{false, true} {
		t.Run(fmt.Sprintf("keyboardInteractive=%v", interactive), func(t *testing.T) {
			defer resetPool()
			server := newTestServer(t, serverOptions{password: "secret", keyboardInteractive: interactive})

			rec := newRecorder()
			Open(specFor(server, nil), nil, rec)
			f := rec.expectFailure(t)
			if f.Kind != "auth" || !f.PasswordAllowed || f.PasswordTried {
				t.Fatalf("no password: %+v", f)
			}

			rec = newRecorder()
			Open(specFor(server, func(s *openSpec) { s.Password = "wrong" }), nil, rec)
			f = rec.expectFailure(t)
			if f.Kind != "auth" || !f.PasswordTried {
				t.Fatalf("wrong password: %+v", f)
			}

			rec = newRecorder()
			ch := Open(specFor(server, func(s *openSpec) { s.Password = "secret" }), nil, rec)
			rec.expect(t, "open")
			ch.Send("hi")
			if e := rec.expect(t, "text"); e.payload != "> hi" {
				t.Fatalf("got %q", e.payload)
			}
			ch.Close()
		})
	}
}

func TestKeyAuth(t *testing.T) {
	defer resetPool()
	signer := newSoftwareSigner(t)
	server := newTestServer(t, serverOptions{authorizedKey: signer.sshKey(t)})

	rec := newRecorder()
	ch := Open(specFor(server, func(s *openSpec) { s.UseKey = true }), signer, rec)
	rec.expect(t, "open")
	ch.Close()

	// A key the server doesn't know, and no password support.
	resetPool()
	rec = newRecorder()
	Open(specFor(server, func(s *openSpec) { s.UseKey = true }), newSoftwareSigner(t), rec)
	f := rec.expectFailure(t)
	if f.Kind != "auth" || !f.KeyTried || f.PasswordAllowed {
		t.Fatalf("unexpected failure %+v", f)
	}

	line, err := AuthorizedKey(signer.PublicKey(), "Faceclaw on my phone")
	if err != nil || !strings.HasPrefix(line, "ecdsa-sha2-nistp256 AAAA") || !strings.HasSuffix(line, " Faceclaw-on-my-phone") {
		t.Fatalf("AuthorizedKey = %q, %v", line, err)
	}
	parsed, _, _, _, err := ssh.ParseAuthorizedKey([]byte(line))
	if err != nil || string(parsed.Marshal()) != string(signer.sshKey(t).Marshal()) {
		t.Fatalf("authorized key does not round-trip: %v", err)
	}
	// The uncompressed-point form iOS hands us parses to the same key.
	point := elliptic.Marshal(elliptic.P256(), signer.key.X, signer.key.Y) //nolint:staticcheck
	fromPoint, err := Fingerprint(point)
	fromDER, _ := Fingerprint(signer.PublicKey())
	if err != nil || fromPoint != fromDER {
		t.Fatalf("fingerprints differ: %s vs %s (%v)", fromPoint, fromDER, err)
	}
}

func TestExecFraming(t *testing.T) {
	defer resetPool()
	server := newTestServer(t, serverOptions{password: "pw"})
	rec := newRecorder()
	Open(specFor(server, func(s *openSpec) { s.Password = "pw"; s.Channel.Command = "bytes" }), nil, rec)
	rec.expect(t, "open")
	var texts, stderr []string
	var closed closedPayload
	for done := false; !done; {
		e := rec.next(t)
		switch e.kind {
		case "text":
			texts = append(texts, e.payload)
		case "stderr":
			stderr = append(stderr, e.payload)
		case "closed":
			json.Unmarshal([]byte(e.payload), &closed)
			done = true
		default:
			t.Fatalf("unexpected %s(%s)", e.kind, e.payload)
		}
	}
	want := []string{`%output %1 caf\303`, `%output %1 \251 ok`, "plain ✓"}
	if strings.Join(texts, "|") != strings.Join(want, "|") {
		t.Fatalf("texts = %q, want %q", texts, want)
	}
	if len(stderr) != 1 || stderr[0] != "oops" {
		t.Fatalf("stderr = %q", stderr)
	}
	if closed.ExitStatus == nil || *closed.ExitStatus != 3 {
		t.Fatalf("closed = %+v", closed)
	}
}

func TestWebSocketTunnelAndSharing(t *testing.T) {
	defer resetPool()
	upgrader := websocket.Upgrader{}
	var serverConns sync.WaitGroup
	wsServer := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serverConns.Add(1)
		defer serverConns.Done()
		defer conn.Close()
		for {
			kind, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if string(data) == "quit" {
				conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(4000, "asked to quit"))
				return
			}
			conn.WriteMessage(kind, append([]byte("echo:"), data...))
		}
	})}
	wsListener, _ := net.Listen("tcp", "127.0.0.1:0")
	go wsServer.Serve(wsListener)
	defer wsServer.Close()

	server := newTestServer(t, serverOptions{password: "pw"})
	wsSpec := specFor(server, func(s *openSpec) {
		s.Password = "pw"
		s.Channel = channelSpec{Type: "websocket", URL: "ws://" + wsListener.Addr().String() + "/"}
	})
	recA, recB := newRecorder(), newRecorder()
	a := Open(wsSpec, nil, recA)
	b := Open(wsSpec, nil, recB)
	// Sent before open: queued until the channel is up.
	a.Send(`{"type":"init"}`)
	recA.expect(t, "open")
	recB.expect(t, "open")
	if e := recA.expect(t, "text"); e.payload != `echo:{"type":"init"}` {
		t.Fatalf("got %q", e.payload)
	}
	b.Send("quit")
	e := recB.expect(t, "closed")
	var closed closedPayload
	json.Unmarshal([]byte(e.payload), &closed)
	if closed.Code == nil || *closed.Code != 4000 || closed.Reason != "asked to quit" {
		t.Fatalf("closed = %+v", closed)
	}
	if n := server.accepts.Load(); n != 1 {
		t.Fatalf("expected both channels on one SSH connection, got %d connections", n)
	}

	// Close flushes queued messages before tearing down.
	a.Send("last words")
	a.Close()
	time.Sleep(300 * time.Millisecond)
	select {
	case e := <-recA.events:
		t.Fatalf("event after Close: %s(%s)", e.kind, e.payload)
	default:
	}

	// Nothing listening at the forwarded address: a channel failure, not a
	// network one (the SSH connection is fine).
	recC := newRecorder()
	Open(specFor(server, func(s *openSpec) {
		s.Password = "pw"
		s.Channel = channelSpec{Type: "websocket", URL: "ws://127.0.0.1:1/"}
	}), nil, recC)
	if f := recC.expectFailure(t); f.Kind != "channel" {
		t.Fatalf("unexpected failure %+v", f)
	}
}

func TestConnectionLoss(t *testing.T) {
	defer resetPool()
	server := newTestServer(t, serverOptions{password: "pw"})
	rec := newRecorder()
	Open(specFor(server, func(s *openSpec) { s.Password = "pw" }), nil, rec)
	rec.expect(t, "open")
	// Kill the SSH connection under the channel.
	poolMu.Lock()
	for _, conn := range pool {
		conn.client.Close()
	}
	poolMu.Unlock()
	if f := rec.expectFailure(t); f.Kind != "network" {
		t.Fatalf("unexpected failure %+v", f)
	}
	// The next channel dials a fresh connection.
	rec = newRecorder()
	ch := Open(specFor(server, func(s *openSpec) { s.Password = "pw" }), nil, rec)
	rec.expect(t, "open")
	ch.Close()
	if n := server.accepts.Load(); n != 2 {
		t.Fatalf("expected a second connection, got %d", n)
	}
}

func TestNetworkFailure(t *testing.T) {
	rec := newRecorder()
	Open(`{"host":"127.0.0.1","port":1,"user":"jim","channel":{"type":"exec","command":"x"}}`, nil, rec)
	if f := rec.expectFailure(t); f.Kind != "network" {
		t.Fatalf("unexpected failure %+v", f)
	}
	rec = newRecorder()
	Open(`not json`, nil, rec)
	if f := rec.expectFailure(t); f.Kind != "config" {
		t.Fatalf("unexpected failure %+v", f)
	}
}
