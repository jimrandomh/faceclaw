# APK extensions

An independent Android APK supplies its own code and pixels through the SDK.
Faceclaw discovers and binds its service in a separate process; it does not
load APK code. Start with the [standalone recipes](APK-RECIPES.md). No T3 app,
bridge or Faceclaw fork is required.

## Features and selection

The contract defines `ui.launcher`, `ui.navigation`, `ui.app-menu`, `ui.window-layout`, `ui.typography`, `ui.notifications`, `notification-content`, `assistant`, `transcription`, `refinement`, and `device-tools`. An APK author chooses how to group these into settings bundles. The host grants each feature separately and keeps an ordered provider list for each feature. Independent features can have different winners. Each winner owns its whole feature; fields from losing providers are not merged into it. Missing fields use the applicable host baseline. Declared dependencies must be satisfied before a provider is eligible.

Disabling, revoking or uninstalling the selected provider reveals the next enabled, granted, compatible provider in the user's order. An ordinary service outage retains the selected owner and uses host behavior for its live features; it does not promote the next contender. Static navigation, window layout and typography remain effective while the signed app is installed and approved, unless they depend on an unavailable live feature. Changing an effective feature invalidates its outstanding requests and surfaces; unrelated features continue. Uncertain work is not replayed through the replacement. Offline approval revocation releases persisted overrides immediately.

Overrides are read from a separate effective snapshot. They never replace the host user's base preferences. Editing a base preference while an override is active changes the value that becomes visible when the override is removed. The Files default-view option applies only when the user has not chosen a Files view.

The separate `notification-content` grant lets an app show native and SDK notification content inside its own visible window, even when it does not control the global notification UI. It defaults to denied. It permits bounded open/dismiss operations; it does not grant reply or global presentation authority.

## UI integration

The launcher provider draws into the pinned launcher window. The host launcher remains its fallback. App menus supply labels and opaque item tokens to the selected APK. The host retains each callback and checks the current window, provider generation, and recent user input before invoking it. Built-in worker apps keep their menu state while the APK draws it; dismissal releases that state, and an unavailable presenter falls back to the host menu. The host's system escape menu remains available. A navigation provider can declare `doubleTap: sleep`, `tapHold: switcher`, and `hold: app-menu`; the host applies that mapping before app back navigation. Watch swipe-left remains back. The provider's enable flag and per-feature grant control whether the mapping applies.

Notification presentation uses a separate SDK surface. The host owns admission, visibility, wake/restore, and the five-second arrival timeout. Awake previews preserve the existing backdrop. A notification-only wake keeps the sleeping app hidden and delays hardware unblanking until the first notification surface frame is submitted. Opening content cancels the timeout and uses the reader surface. Recording, review, and protected APK windows prevent arrival previews from taking over. Notification presentation and device tools have separate grants.

The layout provider may change generic window positioning and switcher behavior. `switcherHeight: display` spans the full panel independently of the foreground app's shorter content band; drawing, touch targets, and screenshot bounds use that same height. Header and height choices for the provider's own window apply only to that APK. Input dialogs can use the compact host layout or fill the configured viewport. Other apps retain their own identity and display settings.

## Shared style

The host publishes effective typography tokens through the SDK. `Ui.style()` supplies one typeface and measurement/drawing policy to cooperative apps. Signal uses that same style for text measurement, wrapping, row sizes, selection borders, and drawing. Removing the override publishes the host's current base style.

The initial font-sharing contract supports the SDK's bundled Inter, Roboto, Roboto Mono, and Montserrat faces. Arbitrary host font paths are not shared. Bitmap fonts and custom installed faces therefore cannot promise pixel-identical text across APKs. Apps that do not use shared style helpers may retain their own styling.

## Setup and release evidence

Install the host and your independently built APK. In Settings > Installed
apps, selecting an Android application opens its phone settings. Complete
mutual host approval, then grant and order only the desired features. Settings
> Priorities shows ordered applications and the current owner for each
behavior. App-owned configuration stays in the APK; permissions and priority
stay in Faceclaw. Existing T3 integrations are one use of this contract, not a
requirement for new applications.

See [the SDK contract](../android-sdk/README.md) for service setup and
capability APIs. External authors should follow the [APK development workflow](APK-DEVELOPMENT.md),
which covers portable kit export, verified emulator installation, approval and
grant boundaries, first-frame evidence, callback tracing, and the redacted
phone diagnostics inspector. Keep generated audit artifacts under
`android-sdk/build/apk-audit/` or a temporary directory; do not put credentials,
notification payloads, audio, pairing codes, or request tokens in logs.

The SDK's [Demo A and Demo B](../android-sdk/priority-demo/README.md) make priority and fallback behavior reproducible without T3 or a bridge. Use the [current acceptance ledger](APK-ACCEPTANCE.md) for release gates. Their dated validation record is historical evidence only.
