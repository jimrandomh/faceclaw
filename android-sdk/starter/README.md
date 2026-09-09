# Faceclaw APK starter

This is a complete Android application project for the portable Faceclaw SDK.
The release kit places an unpacked Maven repository in `sdk-repository/`, so
this project can be copied to a temporary directory and built without the
Faceclaw source checkout.

```sh
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

For a new application, use the kit's `tools/create-app.py` with a unique
`--package` and `--name`. It updates application ID, namespace, source/test
packages and labels together. The unchanged template identity is for one
local smoke test, not multiple independently installed apps. Keep signing
identity stable for updates.

Install the debug APK only on a verified emulator or a development phone. The
service uses the normal protocol-major-1 handshake and the SDK's explicit
Faceclaw host approval dialog. Android capabilities and Faceclaw grants are
separate; this starter requests neither and contains no backend credentials.

`PreviewService` uses typed `HostEvent` callbacks and `WindowState`. It draws a local text-and-circle bitmap after `open` and visible
`visibility` events, redraws on resize and input, and drops frames while hidden
or the display is off. `SettingsActivity` is app-owned phone UI with a saved
marker setting, a matching phone bitmap preview, current connection status and the last selected host, and an
explicit no-extras handoff to the chosen host's settings Activity. The
Faceclaw host owns approval, capabilities, priority, and glasses transport.

`LifecycleTest` replays synthetic events on the JVM and checks frame-allocation
gates and stale provider completion. Extend these tests for your own app state.
