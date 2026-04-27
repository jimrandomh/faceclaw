This is Faceclaw, an Android program that provides user interface on the Even
Realities G2 smart glasses. It is written in a mix of Typescript/NativeScript
(for the user interface parts) and Java (for the low-level bluetooth parts and
for interfacing with Android SDK).

Typescript parts are in app/. Java parts are in App_Resources/Android/src/main/java/com/faceclaw/app/.

If you are working on low-level communication bits, consider checking out
https://github.com/Commute773/g2-kit-unofficial/ and referring to ble/docs/
and ble/gen/ directories inside. That repository contains automatically
extracted protobuf schemas, communication test scripts, and documentation of
caveats that come up when communicating with the headset.

For instructions getting this to compile and install, refer to README.
