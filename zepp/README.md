# Faceclaw Remote for Amazfit Balance

Zepp OS 3.0 companion for the **original Amazfit Balance**, 480 × 480. The phone runs Zepp plus the Zepp-enabled Faceclaw build. No separate relay APK, Termux, USB connection, or Internet server is involved after installation.

Follow [the installation guide](../zepp-install.md) for phone and watch setup. The token field is in Faceclaw Remote's settings inside **Zepp on the phone**.

## Controls

The opening screen follows Faceclaw's Wear OS remote: a black touchpad, central clock, glasses status, and an action tray. Tap **Apps & status** or swipe up from the bottom edge for the tray.

| Input | Action |
| --- | --- |
| Tap pad / press crown on pad | Select on glasses |
| Double tap pad | Back inside an app; sleep at the app switcher; wake an off display |
| Hold pad for 0.6 seconds | Long press, recognized before lifting |
| Tap, then touch again within 0.3 seconds and hold for 0.6 seconds | Short-then-long press, recognized before lifting |
| Swipe pad | Spatial navigation |
| Turn crown on pad | Scroll, respecting Faceclaw's crown direction |
| Apps → turn crown | Select a window or app in the watch list |
| Apps → press crown / tap selected row | Focus a window or launch an app, then return to pad |
| Apps → select open window → **×** | Close that exact window, when Faceclaw permits it |
| Status | Connection, display, lock, sidebar, refresh, help |
| Swipe right in a list / tap **Touchpad** | Return to touchpad |
| Press the **lower side button** once | Leave the watch app and return to the watch app list; glasses apps stay open |

The list groups **On screen**, **Also open**, and **Launch**, like Wear OS. A list crown movement requires 24 degrees and repeats at most every 280ms. Excess rotation is discarded. List selection responds locally even while the phone is answering a status check. The watch display stays on for up to two minutes after interaction; polling stops when the watch screen turns off or the app exits.

Keep your finger still for the hold threshold. Dragging before the threshold
cancels hold recognition. Once a hold is recognized, lifting your finger sends
no extra tap or hold. For tap-then-hold, the second contact must begin within
0.3 seconds after the first tap, then remain down for 0.6 seconds.

If the phone cannot be reached or the token needs attention, tap **Connection details** on the touchpad to read the error. **Retry** (or a crown press on that screen) only refreshes status; it does not repeat a prior command.

To quit from any screen, press the **lower side button** once. This also works while the phone is unavailable or a command is waiting. It cancels pending watch input and status polling; it does not send a close command to the glasses. The crown keeps its select/open behavior. Zepp documents the lower button of its two-button layout as `KEY_SHORTCUT`; `KEY_BACK` is also accepted for compatibility.

This is a port of the supported remote controls, not every Wear OS feature: no microphone assistant, keyboard, motion-sensor pinch taps, multitouch, ambient clock, or held/released input stream. A hold sends the existing discrete gesture once at the threshold; it does not add continuous hold-to-talk or game escape behavior. Opening the watch does not synthesize a click or launch an app on the glasses.

## Command feedback

A two-line banner immediately names the recognized gesture or command. It shows
**Sending**, then **Phone received** when Zepp acknowledges receipt, and
**Faceclaw accepted** when Faceclaw replies successfully. The best-effort phone
receipt can be skipped. Elapsed time stays visible while waiting.
This confirms phone handling; check the glasses for the
visible effect.

If a status check is already running, one gesture or app action can show
**Waiting** for up to one second before it is sent. It is canceled if the state,
target, selection, or screen context changes. **Busy · Not sent** still appears
while an actual action is awaiting its reply; taps, swipes, and app actions do not
queue behind sent actions. Sleeping or locked glasses show the applicable reason. A pending crown
step expires visibly with **Turn crown again**. A timeout, transport loss, or
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

`npm run build` with no ID creates a verification package using placeholder `99999999`. Preview/bridge require a real registered ID. `FACECLAW_ZEPP_APP_ID` also supplies the ID. The packaging wrapper uses a temporary project and leaves the checked-in manifest unchanged. Packaged files are copied to `dist/`. Device IDs: `8519936`, `8519937`, `8519939`; minimum/target API level 3.0; version 0.1.6, package version code 20.

`npm run render -- /path/to/playwright` renders sample states from the real watch widget code and checks for text overflow and circular-screen clipping. These are **layout previews**, not hardware screenshots.

## Transport and limits

Watch → Zepp Side Service → `POST http://127.0.0.1:8791/v1/request` → Faceclaw's existing watch/input dispatch → glasses. Every request carries an existing `fc1_` input token with **Provide input** permission. The token stays in Zepp's phone settings and is not sent to the watch. The endpoint accepts `watch-state`, `watch-command`, and `input`; there are no arbitrary URL or command fields.

The watch's messaging session stays open for the app's lifetime over its existing
Zepp connection. It does not re-pair for each command. ZML still checks that the
phone-side service is ready before each request; this release keeps that
supported transport behavior.

Background status checks normally run 3 seconds after a request completes while
the screen is on, or after 6 seconds following a connection failure. They defer
during active touch and recent input. Successful directional swipes and scrolling
skip the extra immediate status request. Taps, double taps, holds, and commands
still refresh status, including after a double tap wakes the display. Status
after directional navigation is updated by the next idle check.

One unsent gesture or app action may wait up to one second behind a status check.
It is revalidated against the reply and discarded if its state, target, selection,
or context changed, or the watch slept or exited. It never waits behind an action
already being sent. Crown scrolling separately retains at most the latest unsent
step for 350ms behind a status check or crown request. Expired input is discarded;
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
