This is Faceclaw, an Android program that provides user interface on the Even
Realities G2 smart glasses. It is written in a mix of Typescript/NativeScript
(for the user interface parts) and Java (for the low-level bluetooth parts and
for interfacing with Android SDK).

Typescript parts are in app/. Java parts are in App_Resources/Android/src/main/java/com/faceclaw/app/.

wear/ is a separate Gradle project (Kotlin + Compose for Wear OS): the watch
remote that drives Faceclaw over the Wearable Data Layer. Its phone-side
counterparts are FaceclawWearBridge.java, app/native/wear-bridge.ts and
app/g2/wear-remote.ts; the message format is in wear/PROTOCOL.md.

`build.sh` and `build_wear.sh` build the Android and Wear OS apps respectively.
`build_and_run.sh` builds the Android app then also installs it on a phone
paired with `adb`. Building may require configuring environment variables
(JAVA_HOME, ANDROID_HOME, PATH, ANDROID_KEYSTORE, ANDROID_KEYSTORE) to point at
relevant tools and an Android device ID to install on; do this in
build_paths.sh, which is created from build_paths.sh.template and not checked
into git.

To lint and typecheck, prefer to use build.sh; if the user asks you to run or
test the app, use build_and_run.sh and then use `adb logcat` to view the
results.

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

