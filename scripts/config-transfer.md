# Config transfer (Android and iOS)

Both platforms export and import the same JSON config document, so a config
pulled from one phone can be pushed to either platform.

```sh
scripts/pull_config.sh                     # Android -> faceclaw_settings.android.json
scripts/push_config.sh                     # faceclaw_settings.android.json -> Android
scripts/pull_config_ios.sh                 # iPhone -> faceclaw_settings.ios.json
scripts/push_config_ios.sh                 # faceclaw_settings.ios.json -> iPhone

scripts/pull_config.sh && scripts/push_config_ios.sh faceclaw_settings.android.json   # Android -> iPhone
scripts/pull_config_ios.sh && scripts/push_config.sh faceclaw_settings.ios.json       # iPhone -> Android
```

Push also accepts legacy Android shared-preferences XML (`faceclaw_settings.xml`
from older `pull_config.sh`). Pulls write files with mode 600; the default
filenames are gitignored. **Configs contain API keys and Terminal tokens: treat
them as secrets.**

## Format

```json
{
  "schema": 2,
  "platform": "android",
  "appVersion": "0.8.3",
  "settings": {
    "display.timeFormat": "24h",
    "terminal.autoReconnect": true,
    "terminal.connections": [{ "id": "c1", "url": "g2mirror://token@host:8737", "enabled": true }]
  },
  "platformSettings": {
    "deviceAddress.left": "EC:D7:82:69:3C:CB",
    "notifications.sources": [{ "packageName": "com.tailscale.ipn", "appName": "Tailscale", "showOnGlasses": true }]
  }
}
```

- `settings` are imported on any platform.
- `platformSettings` are imported only when `platform` matches the phone importing
  them. They are the settings that would be wrong on another phone: the paired
  glasses and ring, onboarding state, notification sources (Android package names
  vs iOS bundle IDs), Android media apps, file paths (Files bookmarks, Teleprompter
  recents), installed EvenHub packages, per-phone device IDs and `ios.*` internals.
  The list is `SettingsTransfer.isPlatformLocal` in
  `native/kotlin/shared/src/commonMain/kotlin/com/faceclaw/app/settings/SettingsTransfer.kt`;
  every other setting is portable, including ones only one platform uses today, so
  they survive a round trip through the other platform. An enum value one platform
  doesn't offer (e.g. the Android-only "external" assistant backend) is harmless:
  each setting reads as its default when its stored value isn't one of its choices.
- Values are strings, booleans and numbers, as the app stores them. Settings stored
  as JSON text (connections, folders, fonts, timers, EvenHub app storage, ...) are
  written as real JSON objects/arrays when that round-trips exactly; on import any
  object/array is stored back as its compact JSON text.

Schema 1 (a flat `settings` object, from older iOS pulls) is still accepted; its keys
are sorted into portable and platform-local at import time. When editing by hand,
move a key between the two sections to control whether it crosses platforms.

## Semantics

Push **merges**: settings the file doesn't mention are left alone, so a cross-platform
import keeps the target phone's pairing and other platform-local settings. To clear a
value, supply its empty/default value. Malformed files, null values and files over
2 MiB fail before the device is touched (`scripts/config_document.py`) or before
anything is written (the phone re-validates with the same Kotlin codec).

Each import first saves the previous settings: Android writes a config document to
the app's private `files/faceclaw-settings-previous.json`; iOS saves its preferences
to `Library/FaceclawConfigPort/previous.plist`. Both apps restart after an import.

Storage itself is unchanged and per-platform. Android keeps settings in
`shared_prefs/faceclaw_settings.xml`, except the pairing, onboarding and EvenHub
localStorage keys, which still live in NativeScript's `prefs.db.xml`; the export reads
and the import writes each key in the file the app reads it from
(`FaceclawSettingsPortReceiver.nativeScriptKey`). iOS keeps everything in its
NSUserDefaults app domain.

## Android

`pull_config.sh` / `push_config.sh` drive `FaceclawSettingsPortReceiver` with
`am broadcast`, which works on debug and release builds (release builds refuse
`run-as`). The receiver is guarded by `android.permission.DUMP`, so only the adb shell
can trigger it. The document is shuttled through the app's external files dir and
deleted as soon as it has been read. An import writes through the app's live
SharedPreferences, then exits the app so its next launch starts from the imported
settings. Pass `-s SERIAL` (or other adb options) to pick a device.

## iOS

Requires Xcode, Python 3, a development build with `FaceclawConfigPort`, and an
unlocked/trusted iPhone. Both commands restart Faceclaw, briefly interrupting its
Bluetooth and Terminal sessions.

```sh
scripts/pull_config_ios.sh -f /tmp/settings.json --device IPHONE_UDID
scripts/push_config_ios.sh faceclaw_settings.xml   # legacy Android pull_config.sh output
```

Use `--device` / `-d` or set `IOS_DEVICE` when more than one device is connected.
Without either, the script selects the only device with an active Xcode tunnel.
For the simulator, add `--simulator` (defaults to `booted`; `--device` selects one).

`scripts/resetOnboardingIos.sh` is the iOS counterpart of `scripts/resetOnboarding.sh`.
It pulls the config, then pushes every `onboarding.*` key that is set back to its empty
value, which the app reads the same as a missing key. Pushes can't remove keys, and the
plist can't be edited directly (see below). Its `--all` uninstalls the app, since iOS has
no equivalent of `pm clear`.

Transfers use `devicectl` app-container access. The app consumes a uniquely
identified request at bootstrap, before loading settings getters and workers;
it applies imports through NSUserDefaults rather than overwriting a plist that
cfprefsd could restore from cache. Replies are checked against the request ID, so a
stale export cannot appear to confirm an import. Scripts do not print values and
remove their private temporary directory on exit. Device request/reply/backup files
stay in the private Library directory, outside Files/Finder Documents.

Terminal's configured `g2mirror://` scheme uses plain WebSockets; `g2mirrors://`
uses TLS. The iOS build declares local networking and an explicit ATS exception
for the current development server `100.68.94.67`. On iOS 17+, another literal IP
requires its own build-time `NSExceptionDomains` entry, or a TLS endpoint. The
exception does not disable TLS certificate verification. See Apple's
[IP exception rules](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains).
