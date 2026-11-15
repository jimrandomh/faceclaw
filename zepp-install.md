# Faceclaw Remote for Amazfit Balance

This guide installs the Zepp watch remote from this branch. It targets the
**original Amazfit Balance, with its 480 × 480 display**, paired to an Android
phone. Balance 2 is a different device target.

The watch controls Faceclaw's launcher and open windows, including EvenHub apps
installed **inside Faceclaw**. Faceclaw requires its own supported custom G2
firmware. This does not add remote controls to the stock Even Realities phone app
or its native Conversate/Translate features. EvenHub compatibility is the same as
Faceclaw's existing compatibility layer; an app that fails in Faceclaw will not be
fixed by launching it from the watch.

## If you already registered G2 Connect

Reuse your previously registered Zepp **App ID** and developer account. No new
registration is necessary. Complete steps 1–3 for Faceclaw, skip step 4, then use
that existing ID in the build/preview commands in step 5. Installing Faceclaw
Remote with the same App ID replaces the earlier G2 Connect watch app; register
a separate ID only if you want to keep both.

Create a **Faceclaw input token** and save it in the new watch app's Zepp settings
as described below. A previous G2 Connect pairing key does not authorize Faceclaw.

## How the connection works

```text
Balance → Zepp on your Android phone → Faceclaw on the same phone → G2
```

Zepp carries watch messages over the normal watch-to-phone connection. The small
phone-side part bundled with the watch app sends them to Faceclaw's built-in
local server at `http://127.0.0.1:8791/v1/request`. An input token authorizes each
request. Faceclaw uses its existing watch controls to open apps, focus windows
and close windows.

Keep the watch paired to Zepp, and the glasses connected to Faceclaw. Do not pair
the watch directly to the glasses. Everyday use does not need Glassly, Termux,
a separate relay APK, a computer, Developer Bridge, or USB debugging. Installation
and troubleshooting may use a computer.

While Faceclaw Remote is open, it keeps its messaging session over the existing
Zepp connection. You do not need to pair again for each action. The watch screen
stays on for up to two minutes after interaction; when it turns off, status
polling pauses. Version 0.1.7 reuses the readiness handshake while the watch
screen is awake, establishing readiness again after sleep, connection changes or
request failure. This does not keep the screen or phone service awake indefinitely.
It removes a round trip, but a command must still finish before another is sent.

## 1. Install this branch's Android build

Use an Android APK built from this branch. An upstream Faceclaw release predating
this change does not have the Zepp HTTP request endpoint. The Zepp package in
`zepp/dist/` is for the watch; it is not an Android APK.

If building yourself, follow the Android tool setup in [README.md](README.md#compiling),
then run from the repository root:

```sh
npm ci
npm run build
```

Use the APK path printed by the build. A standard debug build writes to
`platforms/android/app/build/outputs/apk/debug/app-debug.apk`. A separately supplied
release artifact may have a different filename; use the artifact explicitly
identified as the **Android phone APK**.

You can copy that APK to the phone and open it in Android's file manager, allowing
installation from that source when Android asks. For a USB installation, enable
Android USB debugging, authorize the computer, and run:

```sh
adb devices
adb install -r /absolute/path/to/the-faceclaw-android.apk
```

Replace the path with the actual APK. `-r` updates an existing installation only
when its application ID and signing certificate are compatible.

### If Faceclaw is already installed

A locally built debug APK is usually signed differently from an upstream release.
Android will refuse to update it with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` or an
equivalent signature error. **Do not uninstall first just to try the APK.**

Prefer a build signed with the same key as the installed version. If you choose
to move to a differently signed build, first export and verify your settings with
the existing app still installed:

```sh
scripts/pull_config.sh faceclaw_settings.android.json
```

Read [config transfer](scripts/config-transfer.md) before proceeding. The export
contains credentials and settings; it is not a complete backup of every
downloaded file or installed app package. Save any other needed content
separately. Only after deciding to replace the installed app and protecting that
data should you remove it in Android, install the new APK, and restore settings:

```sh
scripts/push_config.sh faceclaw_settings.android.json
```

Keep that backup private. Do not post it in an issue or commit it.

## 2. Connect the glasses in Faceclaw

1. Open Faceclaw on the phone and complete its pairing/onboarding screens.
2. Follow Faceclaw's own firmware instructions for your G2. Having another custom
   firmware installed does not establish compatibility; use the firmware
   Faceclaw's onboarding supports.
3. Confirm that Faceclaw shows the glasses connected and that you can open and
   close an app from Faceclaw itself.
4. In **Settings → Watch**, leave watch control enabled.

Do this before diagnosing watch networking. The watch cannot repair a failed
glasses connection or a Faceclaw app that does not render correctly.

## 3. Create and copy an input token

These settings are in Faceclaw's **Settings app inside the glasses interface**,
which is also shown in the preview on the phone. The gear button below that
preview opens a separate phone settings page with display/brightness controls;
it does not contain Input tokens.

Return to Faceclaw's main screen, open **Apps** (the grid icon in the glasses
preview's app switcher), and open **Settings** from that app grid. Use the large
phone touchpad below the preview to navigate: swipe down until **API Keys** is
highlighted in the left column, tap to enter its items, then tap the first item,
**Input tokens**. Tapping the rendered settings text directly in the preview
does not select a settings row. If needed, set the phone gear page's **Phone
input style** to **Watch**; double-tap the touchpad to wake an off display.

1. In that glasses Settings app, open **API Keys → Input tokens** as above.
2. Open **Listening interfaces** and select **Localhost / USB only**.
   Despite that label, localhost works between apps on the same phone with no USB
   cable. Tailscale and a Wi-Fi address are not needed for this setup.
3. Choose **Create token**. Name it `Zepp watch`.
4. Keep **Provide input** set to **On**. App/window controls use this permission.
   Leave the text and assistant permissions off unless you separately need them.
5. Choose **Generate token**, then **Copy token to phone clipboard**.
6. Keep the token available until you paste it into Zepp in step 6. Faceclaw
   shows the secret only at creation time. If lost, revoke it and create another.
7. **Connection information** should show a listener on `127.0.0.1:8791`.

The token is a password for these controls. It belongs in Zepp's settings, not in
the source code, a QR code or a screenshot. Revoking it in Faceclaw disables that
watch configuration.

## 4. Register a Zepp app

1. Install/update Zepp on the same Android phone and confirm that the original
   **Amazfit Balance** is paired and connected.
2. Open the [Zepp developer portal](https://developer.zepp.com/). Sign in with the
   same Zepp account used on the phone; complete any developer-registration
   prompts the portal presents.
3. In the app console's application list, choose **Create App**, enter a name
   such as `Faceclaw Remote`, and submit it.
4. Copy the numeric **App ID** assigned to that app. Use your own registered ID
   in the commands below. `YOUR_APP_ID` is a placeholder, not a value to type.

Zepp documents app registration and the package's matching `appId` in its
[distribution guide](https://docs.zepp.com/docs/distribute/). Registering an ID
and previewing on your own watch are separate from submitting a public store
release.

If you deliberately reuse an App ID from an earlier G2 Connect experiment, the
new package may replace that watch app. Create a separate registration if you
want to keep both. This repository does not commit anyone's personal App ID.

## 5. Install the Balance app through Zepp

From the repository root:

```sh
cd zepp
npm ci
npm run login
npm run build -- --app-id YOUR_APP_ID
npm run preview -- --app-id YOUR_APP_ID
```

Complete the browser login using the same account as Zepp on the phone. If Zeus
asks for a device/target, choose **Amazfit Balance**, not Balance 2. The wrapper
runs Zeus in a temporary project copy containing your App ID. The source
manifest is never rewritten; only generated `dist/` artifacts are copied back.
You can alternatively set `FACECLAW_ZEPP_APP_ID` in your local environment.

On the phone:

1. In Zepp, open **Profile → Settings → About** and tap the Zepp logo seven times
   to enable Developer Mode. Labels may vary slightly with Zepp's version.
2. Return to the paired **Balance** device page and open **Developer Mode**.
3. Use **Scan** in Developer Mode to scan the **new preview QR code** shown by
   the command. A normal camera/QR scanner cannot install a Zepp mini app.
4. Wait for transfer/installation to finish. Open **Faceclaw Remote** from the
   watch's app list.

These are Zepp's [official watch-preview steps](https://docs.zepp.com/docs/guides/quick-start/preview/).
Keep the phone and watch connected during installation. A package appearing in
`zepp/dist/` proves it was built, not that it was installed successfully.

### Alternative: Developer Bridge

Use this when preview scanning fails, or while iterating on the app:

1. In Zepp's Developer Mode, open the **+** menu and enable **Bridge**. Keep that
   phone screen open during the installation.
2. From `zepp/`, run:

   ```sh
   npm run login
   npm run bridge -- --app-id YOUR_APP_ID
   ```

3. At the `bridge$` prompt, enter `connect` and select your online Zepp phone.
4. After it connects, enter `install`, select **Amazfit Balance** when asked, and
   wait for the installation result. Press Enter to accept a highlighted device;
   an arrow pointing at it is still a selection prompt.

See [Zepp's Developer Bridge guide](https://docs.zepp.com/docs/guides/faq/developer-bridge-mode/).
Bridge is an installation/debugging connection. It does not carry normal watch
commands, and you do not need to restart it each time you use the remote.

### Updating an installed watch app

Version **0.1.8 (code 22)** adds rapid directional navigation. Install the updated
Android APK first, then the watch package. After opening the watch app, it can
send up to four swipes/crown steps without waiting for each full reply. The phone
processes them in order; waiting input expires after one second and is canceled
if the target changes or an earlier result is uncertain. Taps, holds and app
commands remain exclusive. A fifth outstanding direction is visibly not sent.
Older phone APKs keep the previous one-request behavior.

Version 0.1.7's connection improvement remains: it reuses the phone messaging session while the watch
screen is awake instead of handshaking before every command. It establishes
readiness again after sleep, connection changes or a failed request. It does not
retry an uncertain command, and **Busy · Not sent** can still appear while the
previous command is awaiting its reply.

The 0.1.6 hold improvements remain: a hold triggers after **0.6 seconds while your
finger is still down**. For tap-then-hold, tap once, touch again within **0.3 seconds**,
and hold that second contact for **0.6 seconds**. Dragging before the threshold
cancels the hold. Lifting after recognition sends no extra event.

This uses the existing discrete gestures. It does not add a continuous
held/released input stream, hold-to-talk, or game escape controls. Version 0.1.5's
reduced status-check interruptions and other earlier fixes remain included.

Install the updated watch package using the same App ID, then leave Faceclaw
Remote with the lower side button and reopen it. This update needs the new phone APK; your existing input token remains valid. The update also includes the earlier command-progress,
local-list-scrolling, and “Watch control off” fixes.

## 6. Paste the token in Zepp

1. In Zepp, open the paired **Balance → App Store → installed/My apps → Faceclaw
   Remote → Settings**. Depending on Zepp's version, the installed-app entry may
   be under **App management** instead.
2. Find the **Faceclaw input token** section.
3. Tap the blue **Enter input token →** button, paste the token copied in step 3,
   and confirm the input. The button becomes **Change input token →** once saved.
4. Return to the watch and reopen Faceclaw Remote to refresh its connection.

Do not put the token in the Zepp developer App ID field. The App ID identifies the
watch package; the input token authorizes access to Faceclaw on your phone.

## 7. Check the controls, then test with the phone locked

The initial screens are **Remote**, **Apps** and **Status**, using the same
remote/app-list/status organization as the Wear OS version. Only controls
actually present in the Zepp app are supported; the Wear OS companion's keyboard,
voice and motion features are not implied.

1. Start with the phone unlocked, Faceclaw connected, glasses worn/unlocked and
   the glasses display awake.
2. Open **Apps** on the watch. Confirm that the list matches Faceclaw's available
   apps and open windows.
3. Turn the crown slowly to move the selection. Press the crown once to open an
   app or focus the selected window. Confirm the result on the glasses.
4. Return to **Apps**, select that window in **On screen** or **Also open**, then
   tap the **×** beside the selected row. The × appears only for an open window
   that can be closed. Confirm that the window disappears on the glasses;
   closing it does not uninstall the app.
5. Test the Remote pad's select/back/scroll controls and check **Status** for
   connection or permission errors. Double tap goes back inside an app, puts the
   display to sleep at the app switcher, and wakes an off display. To test a hold,
   keep a finger still on the pad for 0.6 seconds and check for **Long press**
   before lifting. For **Tap then hold**, start a second contact within 0.3 seconds
   after a tap and hold it for 0.6 seconds. Release should not repeat the gesture.
6. To leave the watch app, press the **lower side button once** from any screen.
   This returns to the watch's app list. It does not close the app on the glasses
   or disconnect Faceclaw, and works without a phone connection. The upper crown
   remains the select/open button.
7. Lock the **phone**, wait at least a minute, and repeat opening, scrolling and
   closing. Repeat after several minutes and after reconnecting the watch.
8. Let the **watch** screen sleep, then wake it and check that status refreshes
   before sending another gesture. Test reconnecting Bluetooth and restarting
   Zepp as well: recovery should restore status without repeating a prior action.
   A silent phone-service restart may cause one failed request before recovery.
9. Swipe several times with the watch awake and check the progress banner. Each
   accepted command should have one effect. A swipe marked **Busy · Not sent**
   must not run later. Compare responsiveness with the prior build; automated
   transport tests do not establish the physical watch's latency.

Phone lock and **Faceclaw's glasses security lock** are different. The server can
run while the phone screen is locked, but a locked glasses session intentionally
rejects protected controls. Taking the glasses off may lock them. Unlock them
through Faceclaw's supported controls; a network connection does not bypass that
lock or the **Settings → Watch** permission switches.

The official Zepp networking API establishes how requests are sent; it does not
guarantee that every Android/Zepp version permits localhost HTTP or keeps its
side service active when locked. Complete this check on your phone before
treating the setup as ready for everyday use. A successful build or simulator
session is not a substitute for this check.

## Read command progress

The watch shows the gesture or command as soon as it is recognized, with a
banner that advances from **Sending** to **Phone received** to **Faceclaw
accepted**. The phone receipt is best effort, so that stage can be skipped.
The elapsed time helps distinguish a slow reply from an undetected
swipe. Phone acceptance does not establish that a glasses frame was displayed.

**Waiting** means a recognized gesture or app action is waiting for a status
check, for at most one second. It is sent only if the latest state and selection
still match. Changing selection, navigating, sleeping, or quitting cancels it.
**Busy · Not sent** means an exclusive action is still awaiting its reply, or
the installed phone APK does not support navigation bursts. With both 0.1.8
components installed, up to four directions can be outstanding. **Too many
swipes · Not sent** means that limit was reached; **Swipe expired · Not sent**
means a waiting direction became more than one second old. **Result unknown** means the reply was lost or invalid;
check the glasses before trying again. A queued crown step that expires shows
**Turn crown again**. Commands are never automatically retried.

Status checks defer while you are touching the pad or have just used a control.
Directional swipes and crown scrolling skip an immediate extra status check.
Taps, double taps, holds, and commands still refresh display and lock information,
so waking the glasses does not leave the watch using an old “display off” state.

## Keep the two phone apps running

Allow background activity for **both Zepp and Faceclaw** in Android's app battery
settings. Keep their requested Bluetooth/nearby-device permissions enabled.
Do not force-stop either app. After a phone restart, open both once and verify
their connections before using the watch.

- On Pixel/stock-style Android, inspect **Settings → Apps → Zepp/Faceclaw → App
  battery usage** and allow background usage. If the device exposes an
  **Unrestricted** option, use it when background restrictions interrupt this
  setup. Battery Saver, especially Extreme Battery Saver, can pause apps; see
  [Google's explanation](https://support.google.com/pixelphone/answer/6187458).
- On Samsung, remove both apps from Sleeping/Deep sleeping lists and add them
  to **Never sleeping apps** (sometimes **Never auto sleeping apps**) under
  **Battery → Background usage limits**. See
  [Samsung's instructions](https://www.samsung.com/uk/support/galaxy-battery/optimisation/).
- Other manufacturers may add an **Auto-start** or **Background activity** switch.
  Use the device's own settings/help; the names differ by Android version.

You can unplug USB and turn off USB debugging after installation. These battery
settings do not require Developer Bridge to remain running.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Preview scan returns HTTP 400 | Use a fresh `preview` QR, your registered App ID, the same account in CLI and phone, and Developer Mode's scanner. Record the complete error if it persists; 400 alone does not identify the cause. Try Bridge installation. |
| “No connectable online App or Simulator” | Open Zepp's Developer Mode, enable Bridge, leave it open, check phone internet access and matching accounts, then run `connect` again. This is the install bridge, not Faceclaw's local connection. |
| “Device not supported” | Check that the connected watch is the original Balance and that the selected package is its target. Its deviceSource values are `8519936`, `8519937`, `8519939`; Balance 2 uses different IDs. See the [official device list](https://docs.zepp.com/docs/reference/related-resources/device-list/). |
| Only “Start install lite app” appears | Wait for the actual result and check the watch app list. That message alone is not confirmation of success. |
| Token missing/unauthorized | Open the clearly labelled token field in Zepp, paste the complete token, save, and reopen the watch app. A revoked token needs replacement. |
| Permission denied | In Faceclaw, check the token's **Provide input** permission and **Settings → Watch**. Check glasses lock separately. |
| Faceclaw cannot be reached | Open Faceclaw, check **Input tokens → Connection information** for `127.0.0.1:8791`, and confirm this branch's APK is installed. Both phone apps must run on the same Android phone. Do not change the address to the watch's or computer's IP. |
| Frequent “Busy · Not sent” | Install watch version 0.1.8 and the matching Android APK. They pipeline up to four directions over the warm session. Taps/holds/app commands remain exclusive. Waiting directions expire after one second; slow transport can still drop input visibly. Watch the progress banner; re-pairing or leaving Developer Bridge open does not remove that wait. |
| Works unlocked, stops after locking the phone | Check background limits for both apps; repeat the locked-phone test. If unresolved, report the phone/Android/Zepp versions and the exact error. Do not assume keeping USB or Bridge connected is the fix. |
| App is listed but glasses stay blank | Open that app directly in Faceclaw. Check glasses connection/display/lock and that app's Faceclaw compatibility before retrying the watch. |
| Faceclaw repeatedly reports “CFW recovery retry limit” | Install this branch's updated Android APK. If G2 repeatedly rejects display-resource allocations, it switches automatically to rendering the complete screen on the phone. App controls remain available; stereoscopic depth and retained glasses-side animations are disabled for that connection. Other transport failures still require diagnosis from the logs. Firmware version `2.3.0.24` alone does not identify incompatibility; Faceclaw checks its separate firmware revision. |
| `npm warn Unknown user config "tokenHelper"` | This is an npm configuration warning, not a watch installation result. Look for the later Zeus build/login/install error. |

## Implementation notes

The HTTP client runs in **`zepp/app-side/` inside the Android Zepp app**, not in
the watch and not in a Glassly/EvenHub WebView. Faceclaw's existing input listener
hosts the endpoint; nothing additional needs to be launched on the phone.

Zepp's [Side Service Fetch API](https://docs.zepp.com/docs/reference/side-service-api/fetch/)
uses `fetch({ url, method, headers, body })`. Its response `body` can be a decoded
object or a JSON string, so the client must support both. Browser assumptions
such as `response.json()`, or undocumented `responseType`/`signal` options, do not
apply. Localhost reachability, lock-screen operation and OEM background behavior
must be checked with the installed Zepp version on hardware.
