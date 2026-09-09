# Faceclaw SDK 0.3.0 developer kit

Build an independent Android app with the included release AAR and sources.
Requires JDK 21, Android SDK 35, Python 3, and internet access for Gradle and
Android build dependencies. The SDK itself resolves from this kit's local
Maven repository.

From the unpacked kit:

```sh
python3 tools/verify-portable-kit.py .
python3 tools/doctor.py --kit .
python3 tools/create-app.py . ../my-app --package dev.example.myapp --name "My app"
cd ../my-app
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

The generator copies the SDK dependency into the new project and gives the app
its own identity. Do not ship multiple copies as `com.faceclaw.starter`. The APK
is `app/build/outputs/apk/debug/app-debug.apk` in the generated project. See the starter's
[README](starter/README.md) and [AI authoring instructions](starter/AGENTS.md).

The [SDK API guide](sdk/README.md), [Java and Kotlin examples](sdk/examples/),
[motion contract](sdk/WINDOW_MOTION.md), and [development workflow](docs/APK-DEVELOPMENT.md)
explain callbacks, approval, grants, provider ownership, and validation. Commands
in those guides that build or audit Faceclaw itself require the source repository.
The [typed event guide](sdk/EVENTS.md), [recipes](docs/APK-RECIPES.md), and
[compatibility policy](sdk/CHANGELOG.md) are the starting points for new apps.
JavaScript motion execution and emulator demo builds require the source
repository; demo source excerpts are included for reference. For this kit, use the
commands above and the tools below.

Generated declaration types, JSON Schema, Java builder, and field reference are
in `generated/`. The native Java contract is authoritative for dependency cycles,
duplicate features, and runtime ownership. For copied phone diagnostics:

```sh
python3 tools/inspect-apk-diagnostics.py diagnostics.json
```

Protocol 1 ordinary windows remain compatible. Global extensions require both
host and app to negotiate extension semantics 2. Updating an existing extension
from older semantics requires republishing with SDK 0.2.0 or newer. SDK 0.3.0
does not change semantics 2 or invalidate compatible 0.2.0 apps.

`PORTABLE-KIT.json` records source revision, dirty state and source-tree digest.
A dirty kit is local review evidence; published artifacts must come from a
clean revision. The release-candidate workflow also supplies a corresponding
source archive and compatible host APK.

`SHA256SUMS.json` covers every kit file except the two checksum manifests.
Checksums detect changed files against that manifest; they are not a release
signature. Preserve an untouched kit for verification and edit a separate copy.
The SDK uses the repository's GNU GPL version 3 license in `LICENSE`; bundled
font notices are in `licenses/fonts/`.
