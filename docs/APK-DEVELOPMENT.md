# Faceclaw APK development workflow

This workflow is for an external Android author using the versioned Faceclaw
SDK. The host remains a separate app and process. The APK keeps its own Android
UID, storage, credentials, permissions, and phone settings. The SDK transports
bounded callbacks and copied bitmaps; it does not load APK code into the host.

## 1. Create and build the app

Follow the [standalone recipes](APK-RECIPES.md) to acquire a candidate kit,
verify it, and generate an app with a unique package ID. From an unpacked kit:

```sh
python3 tools/doctor.py --kit .
python3 tools/create-app.py . ../my-app --package dev.example.myapp --name "My app"
cd ../my-app
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

Host maintainers can generate the same kit with
`android-sdk/scripts/export-portable-kit.sh /tmp/faceclaw-sdk-0.3.0` from the
source repository. App authors do not need that repository after receiving
the kit. Do not copy the template's `com.faceclaw.starter` package unchanged for
multiple apps.

Use `implementation("com.faceclaw:sdk:0.3.0")`. The SDK supports Android 24+
and compiles with Android SDK 35, AGP 8.9.2, Gradle 8.14.3, and Java 11 API
source compatibility. The starter's wrapper and local Maven repository are
part of the kit. A consumer build must not use `includeBuild` or a sibling
Faceclaw checkout.

Declare one exported service extending `FaceclawAppService` with the normal
`com.faceclaw.action.APP_SERVICE` action and protocol-major metadata `1`. Give
the service no extra permission or debug endpoint. Add an exported launcher or
`com.faceclaw.action.APP_SETTINGS` Activity for app-owned phone settings. The
host validates that Activity's package, UID, export state, and permission before
sending a no-extras explicit Intent.

## 2. Install on a verified emulator

Build the debug APK, then verify the emulator serial, Android user, package,
signing key, and SDK level before installing. Use the emulator's own package
manager and record the exact APK path and revision in the audit artifact. The
priority demo's `scripts/test_priority.py` creates synthetic host state and
requires an explicit `--serial`; it is an emulator boundary test, never a
physical glasses installer.

Do not infer physical glasses readiness from a successful emulator frame. A
real device acceptance pass is separate and must cover background restrictions,
BLE transport, sleep/wake, and panel timing.

## 3. Approve the host and grant capabilities

On first connection the SDK verifies the host package, complete signing set,
UID, connection session, and protocol version. A different host causes the SDK
to show its explicit approval Activity. The user must choose **Use this host**;
discovery, launcher settings, and public Intents do not grant approval.

Capabilities are separate from Android permissions and extension declarations.
The host's Permissions and priority screen controls grants and ordered owners.
`publishExtensions` only publishes an app-owned candidate. It never grants a
feature, selects priority, changes a host preference, or authorizes another APK.

The SDK release uses extension semantics 2 while ordinary windows continue to
use protocol version 1. A new host accepts legacy protocol-1 windows, but an
extension declaration is unavailable until the app and host negotiate exact
semantics 2. A saved declaration without the current revision marker remains
preserved but is marked incompatible. Republish with SDK 0.2.0 or newer after updating
the host. An old host may continue ordinary windows while returning extension
publication false/status `host-update-required`; it must not be treated as an
extension-capable host.

## 4. Reach the first frame

Handle `open` and `resize` as the authoritative width, height, and generation.
Handle `visibility` and `screenOn` before drawing. On the main looper, allocate
an ARGB bitmap, draw only app-owned benign content, call `submitBitmap`, and
recycle the bitmap after the synchronous copy returns. Draw the first frame
after the window is visible and awake. Stop animation and frame allocation when
hidden, asleep, closed, resized, revoked, or disconnected. Never assume the
common 576x288 viewport.

`onHostConnected`, `onHostDisconnected`, and typed `onHostEvent(HostEvent)` are app callbacks. See the [event guide](../android-sdk/EVENTS.md) for WindowState, ProviderRequests and consumer replay tests.
Unknown typed callbacks are no-ops. Legacy JSON callbacks remain available for existing apps and advanced protocols. Handle input as a user event and recheck current
window state before acting. An extension surface has the same rules with
`submitExtensionBitmap(feature, bitmap)`, plus current feature ownership and
surface generation.

## 5. Trace callbacks safely

For a development trace, record event names, viewport dimensions, visibility,
screen state, and generation transitions. Do not record notification text,
audio, pairing codes, one-time setup codes, reply tokens, request IDs, backend
credentials, arbitrary callback JSON, or exception payloads. The host's copied
diagnostics JSON is intentionally bounded and excludes those values.

Provider requests are single-use and owner/generation bound. The host supplies a
bounded `deadlineAt` epoch-millisecond field on dispatched request data; treat
it as authoritative even if an APK tried to provide its own value. Reply once
with the SDK method that matches the request. Cancellation, timeout, disconnect,
replacement, or an ambiguous dispatch must not be replayed through a fallback.
Treat a result as authoritative only after matching the current owner,
generation, request, and app state.

## 6. Capture evidence and audit

From the repository root, run the repeatable audit entrypoint:

```sh
scripts/audit-apk-platform.sh
```

It stops before tests/builds when the toolchain doctor fails and prints setup
commands while retaining audit evidence. On a valid toolchain it records the revision, Java/Node/Gradle/Android toolchain doctor, host typecheck
and tests, generator checks, SDK unit/assemble/lint tasks, portable Maven
export, kit link checks, two uniquely scaffolded app builds/tests, a starter build from a copy outside the checkout, and the unmodified
Java and Kotlin examples built against the kit. APKs, source hashes, and lint
reports are retained with the evidence. The result is a
self-contained report under `android-sdk/build/apk-audit/<UTC timestamp>/`.
The optional `--allow-known-upstream-failures` mode accepts only the exact
eight test names in `android-sdk/scripts/known-host-test-failures.txt`; every
other failure remains fatal.

The host inspector can validate a copied phone diagnostics file and emit a
redacted summary:

```sh
python3 android-sdk/scripts/inspect-apk-diagnostics.py diagnostics.json
# From an unpacked portable kit: python3 tools/inspect-apk-diagnostics.py diagnostics.json
```

On the phone, open System behaviors > Diagnostics, choose the APK diagnostics
entry, and use **Copy**. Save that copied JSON as a local audit input. The
inspector requires `schema: 1`, `protocol: 1`, and `extensionSemantics: 2`,
rejects unknown fields, and hashes component identifiers in its human output.
`sequence: 0` means no native first frame has been copied; it is a diagnostic
signal, not proof that physical glasses are ready.

Verify a received kit before building it:

```sh
python3 android-sdk/scripts/verify-portable-kit.py /path/to/faceclaw-sdk-0.3.0
# From an unpacked portable kit: python3 tools/verify-portable-kit.py .
```

## 7. Release checklist

Before sharing an APK, verify the package/signing identity, host approval path,
own UID and storage, no exported debug endpoint, no embedded backend secret,
bounded frame dimensions, visibility/resize handling, capability revocation,
uncertain-result handling, and generated contract artifacts. Run the portable
kit checksum check and build the copied starter from outside the source tree.
Keep emulator, host boundary, and physical-glasses evidence separate.
