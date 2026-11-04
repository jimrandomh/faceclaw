This is Faceclaw, an Android program that provides user interface on the Even
Realities G2 smart glasses. It is written in a mix of Typescript/NativeScript
(for the user interface parts) and Kotlin (for the low-level bluetooth parts and
for interfacing with Android SDK).

Typescript parts are in app/. Android-specific Kotlin parts are in
App_Resources/Android/src/main/java/com/faceclaw/app/ (compiled by the NativeScript
Android build; only the vendored com.k2fsa.sherpa.onnx JNI classes there remain Java).
Shared Kotlin Multiplatform code is in native/kotlin/shared/ (see native/kotlin/README.md).

wear/ is a separate Gradle project (Kotlin + Compose for Wear OS): the watch
remote that drives Faceclaw over the Wearable Data Layer. Its phone-side
counterparts are FaceclawWearBridge.kt, app/native/wear-bridge.ts and
app/g2/wear-remote.ts; the message format is in wear/PROTOCOL.md.

apple-watch/ is the same remote for Apple Watch (Swift + SwiftUI), driving the iOS
app over WatchConnectivity. Its phone-side counterparts are
App_Resources/iOS/src/FaceclawWatchBridge.m, app/native/wear-bridge.ios.ts and the
same app/g2/wear-remote.ts. It only links to a phone app that embeds it
(FACECLAW_EMBED_WATCH=1); see apple-watch/README.md.

`build.sh`, `build_wear.sh` and `build_apple_watch.sh` build the Android, Wear OS
and Apple Watch apps respectively.
`build_and_run.sh` builds the Android app then also installs it on a phone
paired with `adb`. Building may require configuring environment variables
(JAVA_HOME, ANDROID_HOME, PATH, ANDROID_KEYSTORE, ANDROID_KEYSTORE) to point at
relevant tools and an Android device ID to install on; do this in
build_paths.sh, which is created from build_paths.sh.template and not checked
into git.

To typecheck, prefer to use build.sh; if the user asks you to run or
test the app, use build_and_run.sh and then use `adb logcat` to view the
results. `lint.sh` (`npm run lint`) runs oxlint over the TypeScript, including
type-aware rules; rule selection is in .oxlintrc.json.

If you are working on low-level communication bits, consider checking out
https://github.com/Commute773/g2-kit-unofficial/ and referring to ble/docs/
and ble/gen/ directories inside. That repository contains protobuf schemas, as
well as some communication test scripts and documentation of caveats that
come up when communicating with the headset. There may already be an existing
local checkout above this workspace at ../g2-kit-unofficial.

This Android app uses a modded firmware for the G2 smart glasses. Source code
to the corresponding firmware modifications lives in
https://github.com/jimrandomh/g2flash; there is a compiled version of the
firmware patch-set in app/g2/firmware/cfw-patches.ts. Strongly prefer making
changes to the Android app over making changes to changes to the firmware, as
firmware development is considerably more fraught.

