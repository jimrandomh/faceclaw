# Faceclaw for Wear OS

A watch remote for Faceclaw: everything the Even R1 ring can do, plus the
things it can't. Runs on a Wear OS 3+ watch (API 30) paired with the phone
that runs Faceclaw. It is a remote, not a standalone app — without Faceclaw on
the phone it only tells you to install it.

## What it does

**The pad** (the home screen; the whole display is the touch surface):

| On the watch | On the glasses |
| --- | --- |
| tap | select |
| double-tap, or a two-finger tap | **back**, everywhere: closes menus, leaves a settings column, leaves a folder or the launcher grid, returns to the sidebar (and from the sidebar turns the display off, as the ring does) |
| press and hold | the app's context menu (a long press, held until you lift your finger) |
| swipe ↑ ↓ ← → | **spatial navigation, with no mode to enter first**: the launcher highlights one app and the swipe moves it by a row or a column; the settings panel moves between its columns and down its lists; the sidebar moves up and down; Music skips to the previous / next track. Right goes *into* things (sidebar → window, section → items) and left comes back *out* (first column → sidebar). Anywhere without a spatial meaning, up/down scroll, right selects and left goes back. One step per swipe (long swipes used to repeat, which overshot lists whenever the display lagged); use repeated flicks, the crown, or a two-finger page swipe to cover distance. "Natural swipe" flips the vertical sense; left/right can be remapped in settings. |
| rotate the crown | previous / next (one step per detent-ish, sensitivity adjustable) — clockwise is previous by default; reverse it in the on-glasses Settings > Watch section |
| two-finger swipe up / down | scroll a page (3 steps) |
| **twist the wrist twice** (two brisk flicks, either direction) | back — from the gyroscope; on by default, sensitivity adjustable |
| **tip taps** — tap your index finger against your thumb | select; two quick taps = back. From the accelerometer; **off by default** (experimental): on a wrist, ordinary hand movement produced phantom selects in testing. Turn on in Watch settings; needs ~¼ s of stillness before a tap counts, and both motion gestures are ignored while the watch is off the wrist or buzzing. |
| **Tap zones** mode | tap the top / bottom third to scroll, the middle to select — for when swiping is awkward |

The R1 ring's scheme is untouched: the ring only has up/down, tap, double-tap
and hold, so on the glasses it still works in the stock two-step way (pick a
launcher row, tap, pick the app). Watch input is tagged as its own source, so
the same screens give the watch the direct scheme above without the ring
ever seeing a difference.

**Side buttons** (when the app is in front): button 1 tap = select, hold =
long press; button 2 = back; button 3 = "Hey Even". You can also set
the watch's button shortcut to open Faceclaw.

**Bottom row buttons**: Assistant, Type into app, Apps, Status. They are hidden
by default; swipe up beginning at the bottom edge to slide them in, then swipe
down beginning in the button tray to hide them.

- **Assistant** — ask the assistant using the *watch's* microphone (system
  speech recognition) or the Wear keyboard, and read the reply on the watch as
  it streams, mirrored from the glasses overlay. The watch buzzes when the
  reply finishes. "Hey Even" instead opens the glasses' own voice dialog, which
  uses the glasses mic.
- **Type into app** — dictate or type text into the foreground app (the
  terminal, for instance), the same path finalized voice input takes.
- **Apps** — the sidebar's open windows (tap to switch, × to close) and the
  full launcher, including installed EvenHub apps.
- **Status** — connection and battery, display on/off, lock/unlock, connect /
  disconnect, and whether Faceclaw is running on the phone; watch settings
  (haptics, keep screen on, swipe direction, tap zones, horizontal swipe
  actions, tip taps and their sensitivity, crown sensitivity).

The pad keeps the watch display awake while it is showing (Watch settings >
"Keep screen on", default on). Wear OS otherwise dozes within seconds of the
wrist dropping and freezes the app, so the remote would need a wake-up tap
before every gesture.

Phone-side switches live in Faceclaw's Settings > Watch: turn watch control
off entirely, reverse the crown direction, forbid unlocking from the watch,
or stop mirroring assistant replies. While the glasses display is off, every
watch gesture except a double-tap is ignored; double-tap wakes it.

The watch buzzes differently when the phone refuses or doesn't answer a
gesture (glasses disconnected, locked, watch control off); the pill at the
bottom of the pad says why.

## Building and installing

The watch app is a separate Gradle project (Kotlin + Compose for Wear OS).
It needs the same Android SDK the phone build uses and a JDK 17+:

```bash
cd wear && JAVA_HOME=/path/to/jdk ANDROID_HOME=~/Library/Android/sdk ./gradlew :app:assembleDebug
```

The APK lands in `app/build/outputs/apk/debug/`. Install it on the watch over
adb (enable developer options on the watch, then ADB debugging and, for a
watch without USB, Wireless debugging / debug over Wi-Fi):

```bash
adb connect <watch-ip>:5555
adb -s <watch-ip>:5555 install -r app/build/outputs/apk/debug/app-debug.apk
```

Two things must match the phone app or the Data Layer silently won't route:

1. **Application id** `com.faceclaw.app` — already set in `app/build.gradle.kts`.
2. **Signing key.** Debug builds of both apps use the shared Android debug
   keystore (`~/.android/debug.keystore`) on the machine that builds them, so
   building both on the same computer just works. For release builds, sign the
   watch APK with the same keystore as the phone APK.

There's no Play Store listing; sideload.

## Troubleshooting

- *"No phone connected"* — the watch has no Bluetooth link to any phone.
- *"Install Faceclaw on the phone"* — a phone is connected but no app there
  advertises the `faceclaw_phone` capability: the phone build predates the
  watch integration, or the app ids / signing keys differ.
- *"Open Faceclaw on the phone"* — the phone app is installed but its
  dashboard isn't running (Play services started the process just for our
  message). Open Faceclaw once; it keeps running with its foreground service
  while connected to the glasses.
- *"The glasses are not connected"* — tap Status > Connect.
- Nothing happens and no message: check Settings > Watch on the phone.

Gestures the watch itself owns — the edge swipe-to-dismiss, the OS-level
double-pinch / "universal" gestures on some watches — are not available to
apps and aren't remapped here.

Protocol details: [PROTOCOL.md](PROTOCOL.md).
