# Faceclaw SDK 0.2.0 developer kit

Build an independent Android app with the included release AAR and sources.
Requires JDK 21, Android SDK 35, Python 3, and internet access for Gradle and
Android build dependencies. The SDK itself resolves from this kit's local
Maven repository.

From the unpacked kit:

```sh
python3 tools/verify-portable-kit.py .
cd starter
./gradlew :app:assembleDebug :app:lintDebug
```

Keep `starter/` and `sdk-repository/` together when copying the kit. The APK is
`starter/app/build/outputs/apk/debug/app-debug.apk`. See the starter's
[README](starter/README.md) and [AI authoring instructions](starter/AGENTS.md).

The [SDK API guide](sdk/README.md), [Java and Kotlin examples](sdk/examples/),
[motion contract](sdk/WINDOW_MOTION.md), and [development workflow](docs/APK-DEVELOPMENT.md)
explain callbacks, approval, grants, provider ownership, and validation. Commands
in those guides that build or audit Faceclaw itself require the source repository.
The JavaScript motion package and emulator demo source are repository-only
components; their guides are included for reference. For this kit, use the
commands above and the tools below.

Generated declaration types, JSON Schema, Java builder, and field reference are
in `generated/`. The native Java contract is authoritative for dependency cycles,
duplicate features, and runtime ownership. For copied phone diagnostics:

```sh
python3 tools/inspect-apk-diagnostics.py diagnostics.json
```

Protocol 1 ordinary windows remain compatible. Global extensions require both
host and app to negotiate extension semantics 2. Updating an existing extension
requires republishing its declarations with SDK 0.2.0.

`SHA256SUMS.json` covers every kit file except the two checksum manifests.
Checksums detect changed files against that manifest; they are not a release
signature. Preserve an untouched kit for verification and edit a separate copy.
The SDK uses the repository's GNU GPL version 3 license in `LICENSE`; bundled
font notices are in `licenses/fonts/`.
