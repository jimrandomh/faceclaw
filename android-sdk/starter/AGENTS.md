# Starter architecture and evidence guide

## Architecture map

Use SDK 0.3.0 typed `HostEvent` callbacks for new work. Read the shipped
`sdk/EVENTS.md` and `docs/APK-RECIPES.md` in a generated project (one directory
above this template in an untouched kit). Use the generated contract reference
for supported fields. Do not infer APIs from another SDK version.

Generate each new app with `tools/create-app.py --package ... --name ...` from
the kit. Do not reuse `com.faceclaw.starter` or rename only the application ID.
Preserve a generated app's package/signing identity during ordinary changes.

- `app/src/main/AndroidManifest.xml` declares the exported application service,
  launcher/settings Activity, and normal protocol-major-1 metadata.
- `PreviewService` is the external APK process. It owns its UID, service state,
  bitmap allocation, and input counter. It receives only SDK callbacks.
- `SettingsActivity` is the app's phone settings surface. Its persisted marker
  switch changes both the phone bitmap preview and app glasses frame. It shows
  current connection status and the last selected host and hands off to a user-chosen installed host using a no-extras
  explicit Intent. It does not approve a host, grant a capability, accept a
  secret, or expose a debug endpoint.
- `sdk-repository/` is supplied by `scripts/export-portable-kit.sh`; it is the
  only SDK dependency used by this project.

## Lifecycle and rendering

Handle `open` and `resize` as the authoritative viewport. Handle `visibility`
and `screenOn` before allocating a frame. Submit the first frame after the
window is visible, and stop allocating while hidden, asleep, closed, or
disconnected. `submitBitmap` copies synchronously on the main looper; recycle
the app-owned bitmap after it returns. Do not assume a fixed glasses size.

`WindowState` is the lifecycle reducer shared with consumer tests. Feed typed
events to it before rendering and clear it on disconnect. Unknown event types
are ignored. Advanced notification/tool/audio payloads retain their documented
JSON escape hatch; never interpret an unknown event as approval.

Callbacks run on the main looper. Keep animation and UI state in the service,
and redraw after state changes. Use `onHostDisconnected` to clear viewport and
visibility state. Callback payloads are bounded by the SDK; treat unrecognized
events as no-ops.

## Trust and capability boundaries

The host authenticates the APK package, UID, signing identity, session, and
explicit approval before binding. A service's exported declaration makes
discovery possible; it does not grant host access. Faceclaw capabilities and
extension declarations are separate from Android permissions. A declaration is
only a candidate until the user grants and prioritizes its feature in the host.

Never add arbitrary setters, exported debug Activities, or caller-supplied
credentials to a public Intent. Keep secrets and message data in the app's own
storage. Do not log callback payloads, notification text, audio, pairing codes,
tokens, or backend errors. Do not replay an uncertain request after disconnect
or provider replacement. The host owns session, grant, priority, gesture, and
glasses transport decisions.

## Build, test, and evidence

From an exported kit, record the revision and tool versions, then run:

```sh
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

The repository audit entrypoint additionally runs SDK unit tests, generated
contract checks, and a clean starter build in a temporary copy. Emulator
boundary and priority demos are separate evidence jobs. Never use the demo
installer against a real glasses host or treat an emulator first frame as
physical-glasses readiness.

For backend providers, use `ProviderRequests` to reject late, cancelled,
expired or duplicate completion. Feed extension snapshots and cancellations
even while hidden, clear requests on disconnect, and cancel the app's network
tasks separately. Run a synthetic replay covering ownership changes before
connecting real credentials. Report the exact commands/results and any device
cases that remain untested. Use the kit's doctor for missing Java/Android tools.
