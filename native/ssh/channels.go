package faceclawssh

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
)

type closedPayload struct {
	ExitStatus *int   `json:"exitStatus,omitempty"`
	Signal     string `json:"signal,omitempty"`
	Code       *int   `json:"code,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

// runExec runs command on the host and relays newline-delimited text both
// ways until the command exits, the connection drops, or Close.
func (c *Channel) runExec(conn *pooledConn, command string) {
	session, err := conn.client.NewSession()
	if err != nil {
		c.fail(channelOpenFailure(conn, err))
		return
	}
	defer session.Close()
	stdin, err1 := session.StdinPipe()
	stdout, err2 := session.StdoutPipe()
	stderr, err3 := session.StderrPipe()
	if err := errors.Join(err1, err2, err3); err != nil {
		c.fail(&failure{Kind: "channel", Message: err.Error()})
		return
	}
	if err := session.Start(command); err != nil {
		c.fail(&failure{Kind: "channel", Message: "could not run command: " + err.Error()})
		return
	}
	go func() {
		<-c.ctx.Done()
		session.Close()
	}()
	c.markOpen()
	go func() {
		defer c.guard()
		for text := range c.sendQ {
			if _, err := io.WriteString(stdin, text+"\n"); err != nil {
				return
			}
		}
		// Close was called and the queue has drained: EOF tells the command
		// we're done (tmux control mode detaches on it).
		stdin.Close()
	}()
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		defer c.guard()
		readLines(stderr, func(line string) { c.emit("stderr", line) })
	}()
	readErr := readLines(stdout, func(line string) { c.emit("text", line) })
	// Deliver the command's last words (e.g. "tmux: command not found")
	// before the close event, but don't hang on a stderr that never ends.
	select {
	case <-stderrDone:
	case <-time.After(500 * time.Millisecond):
	}
	if c.ctx.Err() != nil {
		return
	}
	waitErr := session.Wait()
	var exitErr *ssh.ExitError
	var missing *ssh.ExitMissingError
	switch {
	case waitErr == nil:
		status := 0
		c.finish("closed", closedPayload{ExitStatus: &status})
	case errors.As(waitErr, &exitErr):
		status := exitErr.ExitStatus()
		c.finish("closed", closedPayload{ExitStatus: &status, Signal: exitErr.Signal()})
	case errors.As(waitErr, &missing):
		// The channel closed without an exit status: usually the connection
		// went away under it.
		c.fail(lostFailure(conn, readErr))
	default:
		c.fail(lostFailure(conn, waitErr))
	}
}

// readLines calls emit for each line of r (without its newline) and returns
// the read error that ended it (nil at EOF). Lines may be arbitrarily long.
func readLines(r io.Reader, emit func(string)) error {
	reader := bufio.NewReaderSize(r, 64*1024)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			if line[len(line)-1] == '\n' {
				line = line[:len(line)-1]
			}
			emit(escapeLine(line))
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// escapeLine makes a line safe to hand across the gomobile boundary as a
// string (which must be valid UTF-8). Valid UTF-8 passes through. Otherwise
// every byte >= 0x80 becomes "\ooo" (backslash, three octal digits): the same
// escape tmux control mode uses for control characters and backslashes in
// %output, so a %output line split mid-character still decodes back to its
// exact bytes. (Outside %output a literal backslash is ambiguous with this
// escape; such lines are only ever displayed.)
func escapeLine(line []byte) string {
	if utf8.Valid(line) {
		return string(line)
	}
	var b strings.Builder
	for _, c := range line {
		if c >= 0x80 {
			fmt.Fprintf(&b, "\\%03o", c)
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}

// runWebSocket opens rawURL (ws://host:port/path) through the SSH
// connection — host:port is resolved on the SSH server's side — and relays
// text frames.
func (c *Channel) runWebSocket(conn *pooledConn, rawURL string) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "ws" || parsed.Host == "" {
		c.fail(&failure{Kind: "config", Message: fmt.Sprintf("bad websocket URL %q", rawURL)})
		return
	}
	target := parsed.Host
	if parsed.Port() == "" {
		target = net.JoinHostPort(parsed.Hostname(), "80")
	}
	dialer := websocket.Dialer{
		NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			forwarded, err := conn.client.DialContext(ctx, "tcp", target)
			if err != nil {
				return nil, err
			}
			return noDeadlineConn{forwarded}, nil
		},
	}
	// The handshake timeout rides the context: SSH channels can't do deadlines.
	handshakeCtx, cancelHandshake := context.WithTimeout(c.ctx, defaultConnectTimeout)
	ws, _, err := dialer.DialContext(handshakeCtx, rawURL, nil)
	cancelHandshake()
	if err != nil {
		if c.ctx.Err() != nil {
			return
		}
		c.fail(channelOpenFailure(conn, fmt.Errorf("could not reach %s on the host: %w", target, err)))
		return
	}
	defer ws.Close()
	go func() {
		<-c.ctx.Done()
		ws.Close()
	}()
	c.markOpen()
	go func() {
		defer c.guard()
		for text := range c.sendQ {
			if err := ws.WriteMessage(websocket.TextMessage, []byte(text)); err != nil {
				return
			}
		}
		ws.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "bye"),
			time.Now().Add(time.Second))
	}()
	for {
		kind, data, err := ws.ReadMessage()
		if err != nil {
			if c.ctx.Err() != nil {
				return
			}
			var closeErr *websocket.CloseError
			if errors.As(err, &closeErr) {
				code := closeErr.Code
				c.finish("closed", closedPayload{Code: &code, Reason: closeErr.Text})
				return
			}
			c.fail(lostFailure(conn, err))
			return
		}
		if kind == websocket.TextMessage {
			c.emit("text", string(data))
		}
	}
}

// noDeadlineConn adapts an SSH direct-tcpip channel for the websocket
// library, which sets deadlines the channel doesn't support. Timeouts come
// from contexts and the SSH keepalive instead.
type noDeadlineConn struct{ net.Conn }

func (noDeadlineConn) SetDeadline(time.Time) error      { return nil }
func (noDeadlineConn) SetReadDeadline(time.Time) error  { return nil }
func (noDeadlineConn) SetWriteDeadline(time.Time) error { return nil }

// channelOpenFailure classifies a failure to open a channel: if the SSH
// connection itself is gone it's a network failure (reconnect), otherwise
// the host refused this particular channel.
func channelOpenFailure(conn *pooledConn, err error) *failure {
	if isConnDead(conn) {
		return &failure{Kind: "network", Message: "connection lost: " + err.Error()}
	}
	return &failure{Kind: "channel", Message: err.Error()}
}

func lostFailure(conn *pooledConn, err error) *failure {
	message := "connection lost"
	if err != nil && !errors.Is(err, io.EOF) {
		message += ": " + err.Error()
	}
	if !isConnDead(conn) {
		// The connection is fine; only this channel ended abruptly.
		return &failure{Kind: "channel", Message: "channel closed unexpectedly"}
	}
	return &failure{Kind: "network", Message: message}
}

func isConnDead(conn *pooledConn) bool {
	// client.Wait's goroutine marks the connection dead slightly after the
	// channels see their streams end; give it a moment to catch up.
	deadline := time.Now().Add(200 * time.Millisecond)
	for {
		poolMu.Lock()
		dead := conn.dead
		poolMu.Unlock()
		if dead || time.Now().After(deadline) {
			return dead
		}
		time.Sleep(10 * time.Millisecond)
	}
}
