# Faceclaw Remote for Amazfit Balance

Zepp OS 3.0 companion for the **original Amazfit Balance**, 480 × 480. The phone runs Zepp plus the Zepp-enabled Faceclaw build. No separate relay APK, Termux, USB connection, or Internet server is involved after installation.

Follow [the installation guide](../zepp-install.md) for phone and watch setup. The token field is in Faceclaw Remote's settings inside **Zepp on the phone**.

## Controls

The opening screen has a black touchpad, central clock, glasses status, and separate **Apps** and **Status** buttons. Both buttons open their screen directly, without an intermediate menu.

| Input | Action |
| --- | --- |
| Tap pad / press crown on pad | Select on glasses |
| Double tap pad | Back inside an app; sleep at the app switcher; wake an off display |
| Hold pad for 0.6 seconds | Long press, recognized before lifting |
| Tap, then touch again within 0.3 seconds and hold for 0.6 seconds | Short-then-long press, recognized before lifting |
| Swipe pad | Spatial navigation |
| Turn crown on pad | Scroll, respecting Faceclaw's crown direction; icon grids traverse left to right, then the next row |
| Apps → turn crown | Select a window or app in the watch list |
| Apps → press crown / tap selected row | Focus a window or launch an app, then return to pad |
| Apps → select open window → **×** | Close that exact window, when Faceclaw permits it |
| Status | Connection, display, lock, sidebar, refresh, help |
| Swipe right in a list / tap **Touchpad** | Return to touchpad |
| Press the **lower side button** once | Leave the watch app and return to the watch app list; glasses apps stay open |

The list groups **On screen**, **Also open**, and **Launch**, like Wear OS. Crown direction is reversed from 0.1.10 in both local lists and glasses controls. A list crown movement requires 24 degrees and repeats at most every 280ms, including direction reversals. Excess rotation is discarded. List selection responds locally even while the phone is answering a status check. The watch display stays on for up to two minutes after interaction; polling stops when the watch screen turns off or the app exits.

Keep your finger still for the hold threshold. Dragging before the threshold
cancels hold recognition. Once a hold is recognized, lifting your finger sends
no extra tap or hold. For tap-then-hold, the second contact must begin within
0.3 seconds after the first tap, then remain down for 0.6 seconds.

If the phone cannot be reached or the token needs attention, tap **Status** on the touchpad to read the error. **Retry** (or a crown press on that screen) only refreshes status; it does not repeat a prior command.

To quit from any screen, press the **lower side button** once. This also works while the phone is unavailable or a command is waiting. It cancels pending watch input and status polling; it does not send a close command to the glasses. The crown keeps its select/open behavior. Zepp documents the lower button of its two-button layout as `KEY_SHORTCUT`; `KEY_BACK` is also accepted for compatibility.

This is a port of the supported remote controls, not every Wear OS feature: no microphone assistant, keyboard, motion-sensor pinch taps, multitouch, ambient clock, or held/released input stream. A hold sends the existing discrete gesture once at the threshold; it does not add continuous hold-to-talk or game escape behavior. Opening the watch does not synthesize a click or launch an app on the glasses.

## Command feedback

A two-line banner immediately names the recognized gesture or command. It shows
**Sending**, then **Phone received** when Zepp acknowledges receipt, and
**Accepted** when Faceclaw replies successfully. The best-effort phone
receipt can be skipped. Durations use seconds to two decimal places, for example **Sending · 0.12s** and **Accepted · 0.24s**. Pending time refreshes every 100ms; completion captures and freezes the elapsed time on reply.
This confirms phone handling; check the glasses for the visible effect. Failed, blocked, expired or uncertain gestures vibrate once. Successful input, status polling and deliberately canceled input stay silent. Late results after sleep, navigation or exit cannot vibrate.

If a status check is already running, one gesture or app action can show
**Waiting** for up to one second before it is sent. It is canceled if the state,
target, selection, or screen context changes. **Busy · Not sent** still appears
while a tap, hold, app action, or legacy-phone request is awaiting its reply.
With the updated phone APK, touch swipes use a burst of up to four requests, each with its own reply ID. Physical crown turns admit one command at a time: extra rotation during any in-flight mutation is quietly discarded without creating a gesture, replacing progress, or vibrating. The phone sends one HTTP request
at a time, and waiting directions expire after one second. A fifth outstanding
input shows **Too many swipes · Not sent**. Taps, holds and app commands stay
exclusive so they cannot overtake navigation. Sleeping or locked glasses show the applicable reason. A pending crown
step waiting behind a read expires quietly with **Turn crown again**. A timeout, transport loss, or
malformed reply shows **Result unknown**; commands are never automatically
retried. Navigation, watch sleep, and exit clear pending input and old feedback.

## Development

Node 24 or later:

```sh
cd zepp
npm ci
npm test
npm run build
npm run login
npm run preview -- --app-id YOUR_APP_ID
# Or use Zepp's developer bridge:
npm run bridge -- --app-id YOUR_APP_ID
```

`npm run build` with no ID creates a verification package using placeholder `99999999`. Preview/bridge require a real registered ID. `FACECLAW_ZEPP_APP_ID` also supplies the ID. The packaging wrapper uses a temporary project and leaves the checked-in manifest unchanged. Packaged files are copied to `dist/`. Device IDs: `8519936`, `8519937`, `8519939`; minimum/target API level 3.0; version 0.1.12, package version code 26.

`npm run render -- /path/to/playwright` renders sample states from the real watch widget code and checks for text overflow and circular-screen clipping. These are **layout previews**, not hardware screenshots.

## Transport and limits

Watch → Zepp Side Service → `POST http://127.0.0.1:8791/v1/request` → Faceclaw's existing watch/input dispatch → glasses. Every request carries an existing `fc1_` input token with **Provide input** permission. The token stays in Zepp's phone settings and is not sent to the watch. The endpoint accepts `watch-state`, `watch-command`, and `input`; there are no arbitrary URL or command fields.

The watch uses its existing Zepp Bluetooth connection; Faceclaw maintains a
separate connection to the glasses. Version 0.1.7 reuses the phone-side readiness
handshake while the watch screen is awake. Sequential requests use the proven
session instead of a new handshake each time. Readiness is invalidated on watch
sleep/exit, Bluetooth changes, or a failed request; the next request establishes
it again. A successful status round trip is required before controls can use
the recovered session. No uncertain command is automatically repeated.

This uses a project-owned adapter for the pinned ZML 0.0.43 transport, preserving
ZML's message format and BasePage response delivery. The adapter and lifecycle
behavior are covered by tests against the installed ZML bundles and page tests.
An unexpected transport shape keeps ZML's original behavior. Zepp's
[official connection guide](https://docs.zepp.com/docs/guides/best-practice/bluetooth-communication/)
supports connecting once and exchanging subsequent messages, but does not promise
that Android will keep the Side Service alive indefinitely. If the phone service
silently restarts, a request can still fail before readiness is re-established.
The normal idle status checks also exercise the session.

Reusing readiness removes a round trip; it does not make slow commands concurrent.
Version 0.1.8 pipelines directional inputs through the same warm session. The
phone forwards one input at a time without waiting for its reply to return over
Bluetooth before receiving the next input. **Busy · Not sent** remains for
exclusive commands and older phone builds. Device latency
and recovery after sleep, service restart, and Bluetooth loss require hardware
verification.

Background status checks normally run 3 seconds after a request completes while
the screen is on, or after 6 seconds following a connection failure. They defer
during active touch and recent input. Successful directional swipes and scrolling
skip the extra immediate status request. Taps, double taps, holds, and commands
still refresh status, including after a double tap wakes the display. Status
after directional navigation is updated by the next idle check.

While successful directional input keeps the idle check deferred, same-target
navigation replies renew a separate 15-second readiness window from send time.
This keeps continuous scrolling usable without treating the app/status snapshot
as freshly read. Taps, holds and app/status commands still need a recent status
read. An expired snapshot or missing navigation context starts an automatic
read, shows **Syncing · Try again**, and silently skips that input. Repeat it
after sync; it is never replayed automatically. Sleep, session/target changes,
rejection and unknown results require fresh state before navigation resumes.

One unsent gesture or app action may wait up to one second behind a status check.
It is revalidated against the reply and discarded if its state, target, selection,
or context changed, or the watch slept or exited. Outside the navigation burst path it never waits behind an action
already being sent. Crown scrolling separately retains at most the latest unsent
step for 350ms behind a status check. It never waits behind a sent crown request. Expired unsent crown intent is quietly discarded;
sent commands use one POST and are never replayed. A timeout means the result is
unknown; check the glasses before trying again. A success reply confirms Faceclaw
accepted the command, not that a glasses frame was displayed.

Requires the Faceclaw build containing this local endpoint, Faceclaw watch control enabled, and Zepp/Faceclaw background operation allowed. Stock Even app launch/exit is outside this integration. The actual Balance → Zepp → Faceclaw path and locked-phone/background behavior require the hardware acceptance checks in the installation guide.

Version 0.1.2 fixes a false “Watch control off” warning on Balance. Zepp owns the
page’s `state` field, so the phone snapshot is now stored separately in
`phoneState`. The watch update preserves the existing input token.

Version 0.1.3 removes phone-response waits from local list scrolling and avoids
an extra status round trip after each crown step on the glasses touchpad. Crown
sensitivity remains unchanged.

Version 0.1.4 adds immediate recognition feedback and correlated command progress,
including visible blocked-input and uncertain-delivery outcomes. Progress uses
one best-effort receipt per command and local elapsed-time updates; polling
adds no progress messages.

Version 0.1.5 reduces interruptions from status checks during input, removes the
extra status wait after directional swipes, and lets one fresh action briefly
wait for an ongoing status check. It preserves display/lock refreshes and never
retries a sent command. The existing phone APK and token remain valid.

Version 0.1.6 recognizes hold and tap-then-hold after 0.6 seconds of contact,
without waiting for release. Dragging before the threshold cancels the hold;
release after recognition sends no duplicate. The existing phone APK and token
remain valid, and the 0.1.5 scheduling improvements remain included.

Version 0.1.7 reuses a successful phone readiness handshake while the watch is
awake. Sleep, connection changes and request failures invalidate the session;
commands waiting to be sent are canceled across a lifecycle change. It retains
command acknowledgements, bounded pending input, and the no-retry policy. The
existing phone APK and token remain valid.

Version 0.1.8 removes the full watch round-trip wait between directional gestures
when the phone advertises navigation support. It requires the corresponding
Android update; older phones retain the single-request behavior. `watch-state`
advertises a navigation version and input target. The Zepp service registers a
watch session, admits up to four numbered directions, and serializes HTTP before
socket creation. It forwards a phone-clock deadline and unique request ID to
`watch-navigation`. The phone rechecks token permission, watch control, display,
lock, connection, target and expiry immediately before input, and reserves IDs
before execution to reject duplicates. Sidebar preview changes keep a stable
sidebar target; changing windows or overlays ends a burst. This is a target
check, not a revision of every selection or page inside an app.

Waiting input expires after one second. Context changes or uncertain outcomes
flush unsent work. Sleep/navigation/exit send a best-effort cancellation for the
old watch session, with short expiry as the fallback if cancellation is lost.
An already dispatched action cannot be retracted. No concurrent POSTs or retries
are used. Replies carry queue/HTTP durations for diagnosis; acceptance still does
not prove a visible glasses frame. Device latency must be verified on hardware.

Version 0.1.9 reduces work on the watch/Zepp path without raising the burst
limit. Touchpad and Status reads omit the catalog and keep only the focused
window's identity; opening Apps still fetches full lists. This preserves queued
input's exact-window check. Direction dispatch and acceptance update the progress
pill without rewriting the complete native layout. The 120-second display lease
is renewed at most every 30 seconds of activity and resets on sleep/wake.
Navigation emits a separate phone-received packet only when HTTP is still
pending after 100 ms; fast commands use their final acknowledgement instead.
The existing navigation-capable phone APK and input token remain valid.

The device report captured before this update showed 139 ms median and 386 ms
maximum input-to-display latency after input reached Faceclaw, while the user
reported multi-second delays with the watch showing Sending. This points toward
the watch/Zepp path, but does not establish the exact cause. Subsequent hardware checks on 0.1.9 were smooth with Zepp foregrounded, backgrounded and Developer Bridge disabled. A captured run acknowledged 31 swipes in 136–275ms; this does not rule out intermittent delays.

Version 0.1.10 adds failure vibration and two-decimal durations on the watch, with direct Apps/Status buttons. The corresponding Android build changes watch crown input in icon grids to reading-order traversal across rows; directional swipes retain their spatial meaning. Ring row/item modes remain unchanged. Vibration uses [Zepp's API 2.0 notification scene](https://docs.zepp.com/docs/reference/device-app-api/newAPI/sensor/Vibrator/), followed by stop, with teardown on sleep/navigation/exit. It does not require a newer Balance API level.

Version 0.1.11 is watch-only. It reverses crown direction in both local lists and glasses controls, rate-limits rapid reversals, and sends at most one physical crown command at a time. Extra turns are dropped before command feedback begins, without queueing or error haptics. A status read may hold the newest crown intent for up to 350ms; expiration stays visible but does not vibrate. A crown command that was sent and fails or has an unknown outcome still vibrates. Touch swipes retain the four-request burst. Local selection redraws only the list, and elapsed-time ticks update only changed feedback properties.

Version 0.1.12 fixes false **Refresh phone first** failures after 15 seconds of
continuous successful navigation. Same-session, same-target acknowledgements
renew only directional readiness. Other actions retain full status freshness
checks. Necessary automatic preparation shows **Syncing · Try again** without
failure vibration or replay. The existing Android build and token remain valid.
