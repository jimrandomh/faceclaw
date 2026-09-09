# Build an independent Faceclaw app

Start from the SDK release candidate kit supplied with the compatible host APK.
The kit is self-contained for Faceclaw dependencies; JDK/Android/Gradle build
dependencies are still required. Download the **faceclaw-sdk-candidate** artifact
from a successful **SDK release candidate** workflow run, or use a locally
exported kit through the [repository-local distribution commands](APK-DISTRIBUTION.md). SDK 0.3.0 is a candidate until a maintainer publishes a release.

From an unpacked, untouched kit:

```sh
python3 tools/doctor.py --kit .
python3 tools/create-app.py . ../weather-app --package dev.example.weather --name "Weather"
cd ../weather-app
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

Choose your own package ID. The generator updates the namespace, application
ID, Java packages, test packages and Android labels together. It refuses an
existing destination and reserved Faceclaw package IDs. A second app must use
a different package ID. Preserve that identity and signing key when updating
an existing app. The generated project includes a local Maven repository and
SDK documentation; it has no source-checkout dependency.

The generated phone Activity previews the same app-owned drawing code used by
the service and saves a marker setting. Install the debug APK on a verified
development device. Approve the app through Faceclaw's Installed apps controls,
then select the host in the app's mutual-consent dialog. App-owned phone
settings and Faceclaw feature grants are separate controls.

## Ordinary display app

Give an AI assistant the generated `AGENTS.md`, the SDK's `EVENTS.md`, and the
service/drawing files. A useful first request:

> Add a weather summary using locally supplied sample data. Keep the current
> package and signing identity. Use typed HostEvent and WindowState callbacks,
> negotiated dimensions, and the existing phone preview. Stop animation and
> allocations while hidden or asleep. Add a consumer test for resize and
> disconnect. Run the project's unit, assemble and lint tasks.

Add a backend only after that preview works. Network work must leave the main
looper. Store credentials in the app's private configuration flow and keep them
out of public Intents, logs and source control.

## Settings/tweak provider

Use the generated `ExtensionDeclarations` builder and configuration reference.
Publish only the features your app needs. The declaration does not grant or
prioritize itself. A useful request:

> Add a phone toggle for a typography candidate using Roboto-Regular.ttf at
> size 16. Preserve the app's local toggle separately from Faceclaw's grants.
> Publish on connection and when the toggle changes. Explain the selected
> owner, typed contenders, priority and dependency reasons from HostEvent.Extensions, and do not write host preferences. Add
> tests for losing typography ownership and removing the declaration.

One owner wins a whole feature. If A provides typography size and B provides a
font, their typography fields are not merged. Missing fields in the winner use
the applicable host baseline. Separate features can have separate winners.
Dependencies require the same app to win their features. Static settings can
persist through a process outage; disabling/revoking/removing the provider
reveals the next eligible contender. Live outages use host fallback while
preserving the selected owner. Use the separate Demo A/B applications to
exercise conflicts through normal host controls.

## Service provider

Use typed `HostEvent.Provider`, `ProviderRequests` and `ProviderResult` for the
assistant/refinement/transcription request lifecycle. Start with a local
pre-dispatch rejection, then add the provider's own backend. A useful request:

> Implement an assistant candidate using my existing backend client. Keep its
> account/project checks. Track the host request ID, feature generation and
> deadline. Feed cancellation and feature changes to ProviderRequests even
> while the window is hidden. Cancel local network work on disconnect. Return
> unknownOutcome after ambiguous dispatch; never retry or switch providers
> automatically. Test stale completion, unrelated feature changes, expiry and
> cancellation before adding live credentials.

The tracker prevents stale final completion; it does not stop your network
task, authenticate a backend, or authorize a send. Notification replies and
reviewed messages have their own documented contracts. A search or draft
transcript is never Send approval.

## Diagnose and share

Run `python3 tools/doctor.py` when the build environment fails. For connection
or ownership problems, copy Faceclaw's APK diagnostics and run
`python3 tools/inspect-apk-diagnostics.py diagnostics.json`. Share the redacted
summary, SDK provenance and test results. Do not share raw callback payloads,
private notifications, audio, tokens or backend errors. Phone preview and JVM
tests do not prove BLE or physical panel behavior; complete the relevant
[acceptance cases](APK-ACCEPTANCE.md) before a ready-for-users claim.
