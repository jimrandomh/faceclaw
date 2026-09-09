# Independent priority demos

Two ordinary SDK applications for testing settings composition, feature priority, lifecycle changes and host fallback without T3, a desktop bridge, credentials or an account. Both can be installed at the same time and run under separate Android UIDs. Normal host approval and individual feature grants are required.

| Variant | Android package | Distinct profile |
| --- | --- | --- |
| Demo A / blue A icon | `com.faceclaw.demo.a` | Inter 18 px, crisp raster, rounded thick borders, centered layout |
| Demo B / purple B icon | `com.faceclaw.demo.b` | Roboto 14 px, antialiased raster, square thin borders, persistent sidebar |

## Start with typography

Use these demos as an advanced SDK example for competing global features. For a first drawing app, start with the smaller [Canvas service](../examples/CanvasAppService.kt).

1. Build and install the host plus both demo APKs using the instructions below. Open Demo B, select **Faceclaw permissions and priority**, approve it, and select the host in the SDK consent dialog. Leave notification and dictation capabilities off for this typography-only exercise.
2. In B's host settings, open **Global customizations and providers** and grant `ui.typography`. Move B first in that feature's priority list. The host should show B's Roboto 14 px profile.
3. Repeat approval and the typography grant for A, then move A above B. The host should show A's Inter 18 px profile. **Inspect live priorities** shows A selected for typography; the other feature grants remain independent.
4. Turn off **Typography** in Demo A. B becomes effective. Turn it on again to restore A. This changes A's declaration, not the host's saved grant or priority.
5. Turn typography off in both demos. With no other eligible typography provider, the host's saved font becomes visible. If T3 or another provider is installed, it can become the next winner; inspect the list before expecting the host baseline.
6. Finish by revoking both demos' approval in the host. Their APKs may then be uninstalled without affecting the host's saved preferences.

## Build and install

Use JDK 21 and Android SDK 35 for the combined host/demo workflow. From `android-sdk`:

```sh
./gradlew :priority-demo:assembleAlphaDebug :priority-demo:assembleBetaDebug
```

The ordinary APKs are:

```text
priority-demo/build/outputs/apk/alpha/debug/priority-demo-alpha-debug.apk
priority-demo/build/outputs/apk/beta/debug/priority-demo-beta-debug.apk
```

Install these APKs on the explicitly selected test device with `adb -s SERIAL install -r APK`. The host and SDK must contain the matching feature-generation lifecycle fixes. For T3 comparison, rebuild the standalone T3 application against this SDK as well. Do not replace an installed app with a different signing identity or uninstall the host to work around an installation failure.

The demos depend on `project(":sdk")` and currently build against SDK 0.2.0.
Global extensions require exact `extensionSemantics: 2` negotiation between
host and client. Protocol major 1 continues to support ordinary app windows;
it does not establish compatibility for global extensions.

Upgrade the host and its extension clients together. Rebuild existing clients
against SDK 0.2.0 and republish their declarations. The host preserves saved
grants and priority while marking older declarations incompatible. For
independent consumers, use the versioned portable kit described in the
[SDK guide](../README.md#portable-developer-kit).

Open each demo from the phone launcher. **Faceclaw permissions and priority** opens the host manager. Approve the app, select that Faceclaw host through the SDK consent dialog, then grant the desired features and set their priority. Declaration toggles never change host grants or the host's underlying preferences.

Typography, navigation, layout and the synthetic assistant are declared enabled initially. Live UI surfaces, transcription and refinement start disabled. All host grants still require user approval. Change the declarations on the demo's phone screen; use **Inspect live priorities** to see selected owner, effective availability, configuration, priority order and per-feature epoch. The in-memory event log is bounded and excludes prompts, audio, notification content and credentials. Offline diagnostics are labeled **last known**.

## Advanced testing

Expand **Advanced testing** on the phone to reveal dependency, withdrawal, failure and Android process controls. This section starts collapsed. Collapsing it only hides controls; it does not reset an active probe. Restore Immediate synthetic response and enable frame delivery after a test.

Synthetic assistant/refinement return canned text. Synthetic transcription ignores audio and returns canned text after Finish. They never contact a backend. Enabling these providers is appropriate for tests, not ordinary assistant work.

- Immediate: a normal local synthetic response.
- Delay: respond after ten seconds, allowing an unrelated app to change or disconnect during the request.
- Reject before dispatch: an explicit synthetic pre-dispatch rejection. A configured host fallback may run, so use a synthetic prompt and a host without live backend credentials for this case.
- Silent: retain the request until the host's normal deadline or user cancellation. A silent provider stays connected; this is distinct from service death.
- Late: wait fifteen seconds and intentionally attempt the original response even after cancellation or a feature ownership change. The host must reject stale authority. Connection loss still cancels all work; this mode never replays across sessions.

**Deliver frames** can be turned off independently to simulate a connected but silent renderer. **Crash this demo process** requires a local confirmation and allows the host's normal reconnect path to run. Static independent overrides persist through an ordinary service outage. Use the host system escape gesture when exercising a silent UI surface.

The launcher and app-menu surfaces can navigate host-provided catalogs. The notification surface displays only synthetic copy and ignores real notification payloads. It does not post notifications or grant reply authority. Generate notification arrivals through a separate synthetic source if testing preview/wake behavior.

**Typography requires this app's launcher** exercises dependencies. A provider must win its declared prerequisite under the same owner. With that option enabled, losing launcher priority makes typography ineligible; losing the live launcher connection makes selected typography unavailable. **Withdraw all declarations** removes the app from contender lists until republished.

## Code map

| Source | What to learn from it |
| --- | --- |
| [DemoSettings.java](src/main/java/com/faceclaw/demo/DemoSettings.java) | Closed declaration schemas, A/B profiles and same-owner dependencies. Host grants and priority are never written here. |
| [DemoService.java](src/main/java/com/faceclaw/demo/DemoService.java) | Connection cleanup, per-feature epoch checks, visible/awake rendering, catalog input and cancellable synthetic providers. The commented late-reply exception is a test probe. |
| [SettingsActivity.java](src/main/java/com/faceclaw/demo/SettingsActivity.java) | Local configuration, host navigation and a live read-only snapshot inspector. Exported Intent extras cannot configure or approve the app. |
| [DemoState.java](src/main/java/com/faceclaw/demo/DemoState.java) | Bounded, content-free process diagnostics. |
| [DemoSetup.java](src/androidTest/java/com/faceclaw/demo/DemoSetup.java) | Emulator-only instrumentation in a separate test APK; excluded from ordinary debug/release demo APKs. |

## Automated emulator suite

```sh
python3 priority-demo/scripts/test_priority.py --serial emulator-5556 --output /path/to/evidence
```

The script requires an explicit serial and checks that it is an emulator before building or installing. It installs a disposable native host, the SDK boundary fixture, both real demos and separate test APKs. It never installs a host stub over `com.faceclaw.app` or the T3 fork. Test instrumentation supplies synthetic consent only to the known disposable host with a matching debug signer. No setup endpoint or consent bypass is exported by either ordinary demo APK.

The suite runs the native boundary regressions and seven scenarios:

1. B -> A priority, ordinary disconnect, offline revocation -> B, then host baseline.
2. A's in-flight request and launcher frames survive a lower contender's unrelated change; lower-app disconnect preserves A's epoch.
3. Different features have different winners; per-feature revocation and reconnect preserve the user's order.
4. Disable, withdraw and republish declarations through the actual demo APK and Messenger boundary.
5. Same-owner dependencies govern eligibility, and live dependency outages invalidate dependent epochs.
6. Launcher row input supplies a bounded action identity; tapping the header does not open an app.
7. An old A reply cannot cross a change to B. Only a new explicit B request succeeds.

App-side setup instrumentation also verifies that forged extras on the exported settings Activity cannot configure the demo. Host Java tests exercise real IPC; TypeScript tests separately exercise shell-side request/review invalidation and baseline font composition. Use [DEVICE-CHECKLIST.md](DEVICE-CHECKLIST.md) as a fresh-run template. [VALIDATION.md](VALIDATION.md) records the September 8, 2026 checks and their remaining limits.

## Scope of validation

Passing this suite does not establish glasses performance, OEM background reliability, automatic outage promotion, or recovery from every silent renderer. The current selection contract intentionally retains an offline winner and uses host behavior for live features. Device acceptance must verify the visible result, reserved gestures, notifications and baseline restoration before an upstream merge proposal is marked ready.
