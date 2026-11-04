# Faceclaw for Apple Watch

A watch remote for Faceclaw on iOS: everything the Even R1 ring can do, plus the
things it can't. It's the same remote as the [Wear OS app](../wear/README.md), and
speaks the [same protocol](../wear/PROTOCOL.md), so the glasses treat them alike.
Needs watchOS 10 or later (Series 6, SE 2, Ultra and newer) and is a remote, not a
standalone app: without Faceclaw on the iPhone it only tells you to install it.

## What it does

**The pad** (the home screen; the whole display is the touch surface):

| On the watch | On the glasses |
| --- | --- |
| tap | select |
| double-tap | **back**, everywhere: closes menus, leaves a settings column, leaves a folder or the launcher grid, returns to the sidebar (and from the sidebar turns the display off, as the ring does) |
| press and hold | the system menu: Focus app switcher, Voice input, Close window (held until you lift your finger; games that use a long press as a move get it instead) |
| tap, then press and hold | the app's context menu |
| swipe ↑ ↓ ← → | **spatial navigation**: the launcher moves one app by a row or a column, the settings panel moves between its columns and down its lists, the sidebar moves up and down, Music skips tracks. Right goes *into* things and left comes back *out*. Anywhere without a spatial meaning, up/down scroll, right selects and left goes back. One step per swipe. |
| turn the crown | previous / next; clockwise is previous. Don't count on it: on a real watch the crown has triggered watchOS's own actions instead of reaching the app. Sensitivity is in the watch's own settings. |
| the Double Tap hand gesture (Series 9, Ultra 2, SE 3 and later, watchOS 11) | select |

Swipe up from the bottom edge to reveal the buttons, and down from them to hide them:

- **Assistant** — ask from the wrist using the system text sheet, which offers
  dictation, and read the reply as it streams. The watch buzzes when it finishes. A
  reply that finishes with your wrist down is waiting when you raise it. "Hey Even"
  instead opens the glasses' own voice dialog.
- **Type into app** — dictate or type into the foreground app, such as the terminal.
- **Apps** — the open windows (tap to switch, × to close) and the full launcher,
  including installed EvenHub apps.
- **Status** — connection, display on/off, lock/unlock, whether Faceclaw is
  answering on the iPhone, and the watch's settings.

Phone-side switches live in Faceclaw's Settings > Watch, including vibration and
sound effects. While the glasses display
is off, a double-tap wakes it and a tap or hold shows the Glanceboard; other gestures
do nothing. The watch buzzes differently when the phone refuses or doesn't answer a
gesture, and the pill at the bottom says why.

With no glasses connected, the pad drives the iPhone's on-screen preview instead, so
all of this can be tried without them.

### What's different from Wear OS

These come from what watchOS allows apps to do:

- **No two-finger gestures.** SwiftUI on watchOS only reports one finger.
- **No side buttons.** The crown press and side button belong to the system.
- **Vibration and sound come as a pair.** watchOS has no call that plays only one, and
  only the watch's own Silent Mode mutes the sound. With sound effects off, every input
  gets a light tap rather than its own cue; with them on, inputs vibrate even if
  Vibrate on input is off.
- **The display can't be kept on.** To keep the remote open between glances, set
  Settings > General > Return to Clock > Faceclaw on the watch to a longer time.
- **The tap that wakes the display does nothing.** The system consumes it, and an
  app can't tell it from a wrist raise, so it can't stand in for a first tap.
- **Holding near the top edge opens Notification Center.** The system takes that
  touch after about 300 ms, and watchOS has no way to defer it. Hold lower down.
- **The system's small clock stays in the corner**, beside the pad's large one. An
  app can't hide it.
- **The glasses' Watch battery indicator can lag.** A closed app can't be asked for
  its level, so it reports when open and when the system grants background time. The
  phone hides a level more than 4 hours old.

There's no tip-tap detector like Wear OS's experimental one; Double Tap is the
system's reliable version of the same idea.

## Building and installing

The watch app is its own Xcode project, so it can be opened and previewed alone:

```bash
./build_apple_watch.sh             # simulator build, no signing
./build_apple_watch.sh --device    # signed build for a real watch
./build_apple_watch.sh --install   # as --device, then installs on the paired watch
npm run install:apple-watch        # the same as --install
```

**It only works with a phone app that embeds it.** The system links the two apps
through the copy in the phone app's `Watch/` folder; install them separately and each
reports the other as not installed. Embedding is off by default, because signing it
needs a watch registered to your team and would break device builds for everyone
without one. To turn it on, in `build_paths.sh`:

```bash
export IOS_TEAM_ID=...            # as for any iOS device build
export FACECLAW_EMBED_WATCH=1
```

Then, the first time:

1. Connect the iPhone, and enable Developer Mode on the watch (Settings > Privacy &
   Security; it appears after Xcode has seen the watch in Window > Devices and
   Simulators). After it restarts, accept any "Trust this computer" prompt.
2. `./build_apple_watch.sh --install`, which registers the watch with your team and
   installs the app on it.
3. `npm run run:ios -- --device <iphone-id> --no-hmr` builds and installs the iPhone
   app with the watch app inside.

Xcode has to be new enough for the watch's OS: Xcode 26.4 can't prepare a watch on
watchOS 27 for development ("Could not support development", "doesn't have a known
architecture"), and that also blocks registering it and installing directly. On an
older Xcode you can still add the watch's UDID by hand at developer.apple.com and let
the iPhone's Watch app install the embedded copy.

To see what the watch shows without looking at it (Xcode 27):

```bash
xcrun devicectl device capture screenshot --device <watch-udid> --destination watch.png
```

A hook (`scripts/apple-watch-embed.cjs`) adds the watch project to the generated iOS
project after each prepare, and takes it back out if the setting is removed. The
bundle ID follows `IOS_BUNDLE_ID` (the watch app's is `<that>.watchkitapp`) and the
version follows `app/version.ts`.

## Testing

```bash
node tests/apple-watch-native.cjs             # gestures, wire format, status line, on the Mac
node --test tests/ios-watch-remote.test.cjs   # the phone side
```

The UI tests drive the real app with synthesized touches on a watch simulator. Those
that talk to the phone need Faceclaw running on the paired iPhone simulator, and skip
themselves otherwise:

```bash
# Once: a watchOS simulator runtime and a pair (ids from `xcrun simctl list devices`).
xcodebuild -downloadPlatform watchOS
xcrun simctl pair <watch> <iphone>
xcrun simctl boot <iphone>; xcrun simctl boot <watch>

# The phone app, embedding the watch app.
FACECLAW_EMBED_WATCH=1 scripts/ios.sh build ios
xcrun simctl install <iphone> platforms/ios/build/Debug-iphonesimulator/faceclaw.app
xcrun simctl spawn <iphone> defaults write com.faceclaw.app onboarding.complete -bool YES
xcrun simctl spawn <iphone> defaults write com.faceclaw.app onboarding.previewOnly -bool YES
xcrun simctl launch <iphone> com.faceclaw.app

# The tests, which install the watch app themselves.
xcodebuild test -project apple-watch/Faceclaw.xcodeproj -scheme Faceclaw \
  -destination "platform=watchOS Simulator,id=<watch>" \
  -derivedDataPath apple-watch/build CODE_SIGNING_ALLOWED=NO

# What the phone made of each gesture.
xcrun simctl spawn <iphone> log show --last 5m --style compact \
  --predicate 'process == "faceclaw" AND eventMessage CONTAINS "apple-watch"'
```

The simulator delivers messages in bursts about a second apart, which real hardware
isn't expected to do; don't judge gesture latency from it. `XCUIElement.tap()` lands
near an element's top-left corner, so tests that hold must use a coordinate.

## Troubleshooting

- *`Timed out while attempting to establish tunnel`, or the watch stays `connecting`
  in `devicectl`* — check the watch's Wi-Fi network. It has to reach this Mac directly,
  and a watch that joined a different network on the same router fails like this, even
  though it still looks paired. It also powers down Wi-Fi when idle, so raise your
  wrist; the first connection can take a minute or two.
- *"No phone"* — the watch can't reach the iPhone right now.
- *"Install Faceclaw on phone"* — the system doesn't see a linked phone app: it isn't
  installed, or it was built without `FACECLAW_EMBED_WATCH=1`, or the bundle IDs differ.
- *"Open Faceclaw on phone"* — the phone app woke for our message but its dashboard
  isn't up (for instance, onboarding isn't finished). Open it once.
- *"The glasses are not connected"* — tap Status > Connect.
- Nothing happens and no message: check Settings > Watch on the phone.

Protocol details: [wear/PROTOCOL.md](../wear/PROTOCOL.md).
