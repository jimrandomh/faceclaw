# Faceclaw Remote for Amazfit Balance

Zepp OS 3.0 companion for the **original Amazfit Balance**, 480 × 480. The phone runs Zepp plus the Zepp-enabled Faceclaw build. No separate relay APK, Termux, USB connection, or Internet server is involved after installation.

Follow [the installation guide](../zepp-install.md) for phone and watch setup. The token field is in Faceclaw Remote's settings inside **Zepp on the phone**.

## Controls

The opening screen follows Faceclaw's Wear OS remote: a black touchpad, central clock, glasses status, and an action tray. Tap **Apps & status** or swipe up from the bottom edge for the tray.

| Input | Action |
| --- | --- |
| Tap pad / press crown on pad | Select on glasses |
| Double tap pad | Back / wake glasses |
| Hold pad, then release | Long press |
| Tap then hold and release | Short-then-long press |
| Swipe pad | Spatial navigation |
| Turn crown on pad | Scroll, respecting Faceclaw's crown direction |
| Apps → turn crown | Select a window or app in the watch list |
| Apps → press crown / tap selected row | Focus a window or launch an app, then return to pad |
| Apps → select open window → **×** | Close that exact window, when Faceclaw permits it |
| Status | Connection, display, lock, sidebar, refresh, help |
| Swipe right in a list / tap **Touchpad** | Return to touchpad |
| Press the **lower side button** once | Leave the watch app and return to the watch app list; glasses apps stay open |

The list groups **On screen**, **Also open**, and **Launch**, like Wear OS. A list crown movement requires 24 degrees and repeats at most every 280ms. Excess rotation is discarded. List selection responds locally even while the phone is answering a status check. The watch display stays on for up to two minutes after interaction; polling stops when the watch screen turns off or the app exits.

If the phone cannot be reached or the token needs attention, tap **Connection details** on the touchpad to read the error. **Retry** (or a crown press on that screen) only refreshes status; it does not repeat a prior command.

To quit from any screen, press the **lower side button** once. This also works while the phone is unavailable or a command is waiting. It cancels pending watch input and status polling; it does not send a close command to the glasses. The crown keeps its select/open behavior. Zepp documents the lower button of its two-button layout as `KEY_SHORTCUT`; `KEY_BACK` is also accepted for compatibility.

This is a port of the supported remote controls, not every Wear OS feature: no microphone assistant, keyboard, motion-sensor pinch taps, multitouch, ambient clock, or held/released input stream. Hold sends the completed long-press gesture when released. Opening the watch does not synthesize a click or launch an app on the glasses.

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

`npm run build` with no ID creates a verification package using placeholder `99999999`. Preview/bridge require a real registered ID. `FACECLAW_ZEPP_APP_ID` also supplies the ID. The packaging wrapper uses a temporary project and leaves the checked-in manifest unchanged. Packaged files are copied to `dist/`. Device IDs: `8519936`, `8519937`, `8519939`; minimum/target API level 3.0; version 0.1.3, package version code 17.

`npm run render -- /path/to/playwright` renders sample states from the real watch widget code and checks for text overflow and circular-screen clipping. These are **layout previews**, not hardware screenshots.

## Transport and limits

Watch → Zepp Side Service → `POST http://127.0.0.1:8791/v1/request` → Faceclaw's existing watch/input dispatch → glasses. Every request carries an existing `fc1_` input token with **Provide input** permission. The token stays in Zepp's phone settings and is not sent to the watch. The endpoint accepts `watch-state`, `watch-command`, and `input`; there are no arbitrary URL or command fields.

State is polled 3 seconds after a request completes while the screen is on, or after 6 seconds following a connection failure. Successful crown scrolling skips an extra immediate status request. While a poll or crown request is pending, only the latest unsent crown step is retained for up to 350ms; stale steps and steps pending when a request fails, another action is taken, or the screen/app closes are discarded. Commands use one POST and are never automatically replayed. A timeout means the result is unknown; check the glasses before trying again. A success reply confirms Faceclaw accepted the command; it is not independent proof of a rendered frame.

Requires the Faceclaw build containing this local endpoint, Faceclaw watch control enabled, and Zepp/Faceclaw background operation allowed. Stock Even app launch/exit is outside this integration. The actual Balance → Zepp → Faceclaw path and locked-phone/background behavior require the hardware acceptance checks in the installation guide.

Version 0.1.2 fixes a false “Watch control off” warning on Balance. Zepp owns the
page’s `state` field, so the phone snapshot is now stored separately in
`phoneState`. The watch update preserves the existing input token.

Version 0.1.3 removes phone-response waits from local list scrolling and avoids
an extra status round trip after each crown step on the glasses touchpad. Crown
sensitivity remains unchanged.
