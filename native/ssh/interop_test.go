package faceclawssh

import (
	"encoding/json"
	"net"
	"os"
	"strconv"
	"testing"
)

// TestOpenSSHInterop checks the parts of the handshake that need no
// credentials against a real sshd: key exchange, host key reporting and
// pinning, and how an authentication refusal is classified. Opt-in:
//
//	FACECLAW_SSH_INTEROP_ADDR=127.0.0.1:22 go test -run Interop -v
//
// Compare the logged fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.
// It makes one failed login attempt (no password, an unknown key) as
// FACECLAW_SSH_INTEROP_USER (default: $USER).
func TestOpenSSHInterop(t *testing.T) {
	addr := os.Getenv("FACECLAW_SSH_INTEROP_ADDR")
	if addr == "" {
		t.Skip("FACECLAW_SSH_INTEROP_ADDR not set")
	}
	defer resetPool()
	user := os.Getenv("FACECLAW_SSH_INTEROP_USER")
	if user == "" {
		user = os.Getenv("USER")
	}
	host, portText, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(portText)
	spec := func(hostKeys []string) string {
		encoded, _ := json.Marshal(openSpec{
			Host: host, Port: port, User: user, HostKeys: hostKeys, UseKey: true,
			Channel: channelSpec{Type: "exec", Command: "true"},
		})
		return string(encoded)
	}

	rec := newRecorder()
	Open(spec(nil), newSoftwareSigner(t), rec)
	f := rec.expectFailure(t)
	if f.Kind != "hostkey-unknown" || f.HostKey == nil {
		t.Fatalf("first contact: %+v", f)
	}
	t.Logf("host key: %s %s", f.HostKey.Type, f.HostKey.Fingerprint)

	rec = newRecorder()
	Open(spec([]string{f.HostKey.Key}), newSoftwareSigner(t), rec)
	auth := rec.expectFailure(t)
	if auth.Kind != "auth" || !auth.KeyTried {
		t.Fatalf("pinned, unknown key: %+v", auth)
	}
	t.Logf("auth refusal: %+v", auth)
}
