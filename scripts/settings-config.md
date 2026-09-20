# Settings format and migrations

Android and iOS use `faceclaw_settings.jsonc`, with the same schema:

```jsonc
{
  "schema": 2,
  "settings": {
    // Setting names remain flat; structured values are real objects/arrays.
    "terminal.connections": [{ "url": "g2mirror://user@host" }],
    "teleprompter.recents": [],
    "terminal.autoReconnect": true,
  },
}
```

JSONC accepts `//` comments, `/* block comments */`, and trailing commas. App
writes and exports produce indented JSON (valid JSONC); comments are not retained
after edits or migration. The existing string settings API serializes/deserializes
structured values at its boundary so callers need not change together.

The live files are `files/faceclaw_settings.jsonc` in the Android app container
and `Library/faceclaw_settings.jsonc` on iOS. Each process shares one native store
across JS isolates. Native locks serialize updates, and atomic file replacement
prevents partial writes. Failed writes leave the in-memory document unchanged.

When no JSONC file exists, Android imports `shared_prefs/faceclaw_settings.xml`
through SharedPreferences. It also imports the pairing, onboarding and EvenHub
keys that previously lived in NativeScript's `prefs.db.xml`, including its
encoded-double timestamp. iOS imports its persistent NSUserDefaults app domain.
Legacy preferences are retained; an existing JSONC file always takes precedence,
even if malformed or from a newer schema. Invalid files are reported rather than
silently reset or overwritten. Schema 1 JSON imports migrate to schema 2.

Schema 2 converts the known structured keys (connections, recents, saved places,
folders, fonts, timers, conversations, app lists, microphone config and iOS BLE
identities). Other strings stay strings. Empty or malformed legacy structured
values are retained so existing application fallback behavior still applies.

`SettingsDocument.kt` owns the common codec, typed access and migration registry.
To add a migration, increase `CURRENT_SCHEMA` and register a pure N → N+1
transformation in `migrations`. Add a test in `SettingsTest.kt` and update the
host-side mirror in `scripts/settings_config.py`. Test old-version import,
round trips, repeated reads, and future-version rejection. The native adapters
persist the migrated result only after the entire migration chain succeeds.

Android's `scripts/pull_config.sh` and `scripts/push_config.sh` now default to
`faceclaw_settings.jsonc` and use the adb-only receiver for both debug and release
builds. Push accepts JSONC, schema 1 JSON, and old Android XML; it replaces the
settings document and saves `faceclaw_settings.jsonc.previous` first. Relaunch
the app after pushing. [iOS transfers](ios-config.md) retain their merge behavior.
Both platforms use the shared native codec to validate incoming documents.

Validation:

```sh
npm test
npm run test:kotlin
node tests/ios-config-native.cjs  # macOS, Xcode, Kotlin/Native
```
