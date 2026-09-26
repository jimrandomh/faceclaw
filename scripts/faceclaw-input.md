# Faceclaw input tokens and CLI

In **Settings → API Keys → Input tokens**, choose **Create token**, give it a
name, select its permissions, and choose **Generate token**. Copy or save the
secret before leaving the result menu: Faceclaw stores only its SHA-256 hash.
Select an existing token to change permissions or revoke it. A token with no
permissions is disabled. Up to 32 tokens can exist at once.

Permissions are independent:

- **Provide input** simulates watch or ring gestures, including navigation,
  taps and the system menu. It has the same reach as those input devices.
- **Text to foreground window** delivers text to the selected app's text input.
- **Text to voice assistant** submits a query to the configured assistant.

Text delivery is rejected while the glasses are locked. Gestures pass through
the existing lock-screen and sleep behavior. The assistant must be configured;
the selected window must accept text. Android requires connected glasses; iOS
also allows the active phone preview. An assistant acknowledgment means the
query was submitted, not that the assistant has finished answering.

## Connect

While at least one token exists, Faceclaw listens on **127.0.0.1:8791** and,
by default, detected **Tailscale addresses**. It never binds a wildcard or a
Wi-Fi/LAN address. Under **Input tokens → Listening interfaces**, choose:

- **Localhost + Tailscale (auto)**: detect a named Tailscale tunnel or a tunnel
  with Tailscale's dedicated IPv6 prefix; bind its tailnet IPv4/IPv6 addresses.
- **Localhost / USB only**: disable remote network access.
- A specific **tunnel interface** (such as `tun0` or `utun3`): use this when
  automatic identification is unavailable, including IPv4-only VPN setups.

Automatic detection uses the prefixes in [Tailscale's address documentation](https://tailscale.com/docs/concepts/ip-and-dns-addresses).
A CGNAT IPv4 address by itself is not sufficient to identify Tailscale. The
interface picker shows names and addresses of tunnel interfaces; choose the
one belonging to Tailscale. Physical Wi-Fi, Ethernet, and cellular interfaces
are excluded. Interface selection is saved; addresses are refreshed every
three seconds after a tunnel connects, disconnects, or changes address.
Localhost remains available even when the selected tunnel is absent.

**Connection information** shows the actual listening addresses. From a
computer on your tailnet, pass the phone's displayed Tailscale address:

```sh
node scripts/faceclaw-input.cjs --host 100.x.y.z interactive
```

Apps on the same phone can connect directly to localhost. From a computer,
you can also forward the port over USB:

```sh
# Android (ADB must already be paired/authorized)
adb forward tcp:8791 tcp:8791

# iOS, using libimobiledevice's iproxy with a trusted, connected phone
iproxy 8791 8791
```

Keep Faceclaw running; iOS
can suspend it when backgrounded without an active glasses session. Revoking
the last token stops the listener.

## Command-line utility

The utility requires Node.js 18+. Run `npm install` in this checkout to install
its [Enquirer](https://github.com/enquirer/enquirer) text editor, then run the
CLI below. For use on another computer, copy both `faceclaw-input.cjs` and
`faceclaw-input-editor.cjs` into one directory and run
`npm install enquirer@2.4.1` there. One-off commands do not load the editor.

```sh
export FACECLAW_TOKEN='fc1_…'  # Paste the generated token
node scripts/faceclaw-input.cjs input tap
node scripts/faceclaw-input.cjs input up
node scripts/faceclaw-input.cjs input scroll-down --source ring
node scripts/faceclaw-input.cjs text 'Text for the foreground app'
node scripts/faceclaw-input.cjs text -n 'Type without pressing Enter'
node scripts/faceclaw-input.cjs assistant 'What is on my calendar?'
node scripts/faceclaw-input.cjs interactive
```

`npm run input -- …` is also available. Use `--token-file FILE` instead of the
environment variable to read a token from a file. `--host` and `--port` (or
`FACECLAW_HOST` and `FACECLAW_PORT`) select a forwarded endpoint. Messages
starting with `--` can follow an option terminator, e.g. `text -- '--help'`.
For terminal windows, text normally appends Enter; `text -n` suppresses that
submission, like `echo -n`. Embedded newlines in the message are preserved.
Other apps receive the text unchanged. Assistant messages do not accept `-n`.
One-off commands return a nonzero exit code on rejection or connection failure.
The CLI never automatically replays an input or message after a failure,
since delivery may already have occurred.

Interactive mode connects and authenticates immediately, without waiting for a
keypress. It validates the token using a side-effect-free `ping`, then checks
connectivity periodically while idle. Each action checks its own permission,
so a token with only text or assistant permission can also use composition. If a request fails, it reports
the error, drops queued keys, and keeps trying to reconnect until Ctrl-C.
It never replays a possibly-delivered gesture. Each request uses a fresh socket,
kept open until the reply arrives (including when using USB forwarding).
Update the phone app alongside the CLI so it supports `ping`.

Interactive mode maps arrow keys to watch directions, Enter to tap, Esc to
double-tap, and Tab to a complete long-press (press and release). Ctrl-C exits
and restores terminal settings. Esc uses a short disambiguation delay to tell
it apart from arrow-key escape sequences. Events are serialized, with a bounded
queue to prevent excessive key-repeat lag.

### Compose text or an assistant message

From interactive controls, press **i** to compose text for the foreground
window, or **a** to compose a message for the assistant. A labeled Enquirer
prompt replaces the gesture controls until you finish:

- **Enter** sends the draft once and returns to controls. Foreground text uses
  the normal submission behavior, including Enter in terminal windows.
- **Esc** discards and clears the draft, then returns to controls.
- **Ctrl-C** discards the draft and quits the utility.

While composing, arrows edit the line; Tab, Enter and Esc never send watch
gestures. The letters `i` and `a` are ordinary text. The editor supports
Left/Right, Home/End, Backspace/Delete, Ctrl-A/E (start/end), Ctrl-W (delete the
previous word), and Ctrl-K (delete to the end). Input is a single line, with
an 8000-character limit; an empty draft sends nothing. Every new draft starts
empty, and no message history is stored. Connection-status output is deferred
while the editor is visible so it cannot corrupt the prompt.

The token needs **Text to foreground window** for `i` and **Text to voice
assistant** for `a`. A permission rejection is reported and returns to controls;
it does not end the interactive session or resend the message.

## Protocol for other apps

Open a TCP connection, send one UTF-8 JSON object terminated by a newline, and
read a newline-terminated JSON reply. Each connection carries one request.
Authentication and current permissions are checked for every request.

```json
{"version":1,"token":"fc1_…","action":"input","gesture":"click","source":"watch"}
{"version":1,"token":"fc1_…","action":"text","text":"hello","submit":false}
{"version":1,"token":"fc1_…","action":"ping","permission":"input"}
{"version":1,"token":"fc1_…","action":"assistant","text":"Hello"}
```

Input gestures: `click`, `double-click`, `long-press`, `short-then-long-press`,
`scroll-up`, `scroll-down`, `swipe-up`, `swipe-down`, `swipe-left`, `swipe-right`.
Source defaults to `watch`; `ring` supports all except the four swipes.
The CLI also accepts `tap`, `double-tap`, `up`, `down`, `left`, `right` aliases.

`submit` is an optional boolean for `text`, defaulting to `true`; `false`
suppresses the terminal app's appended Enter. `ping` validates the token and,
if supplied, the requested `permission`, without dispatching any input or
requiring connected glasses.

Successful reply: `{"ok":true}`. Rejections contain `ok:false`, `error`, and
`message`. Error codes: `bad_request`, `unauthorized`, `forbidden`, `locked`,
`unavailable`, `failed`, `timeout`. Malformed framing closes the connection.
Frames are limited to 64 KiB; text to 8000 JavaScript UTF-16 code units and must
contain non-whitespace text without NUL. Whitespace in valid text is preserved.
Connections have a five-second read deadline and five-second dispatch deadline.
Each listening address serves one connection at a time with a bounded socket backlog.
Token values and request text are never written to the server log.
