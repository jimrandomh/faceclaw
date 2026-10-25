# @faceclaw/evenhub-extensions

Types and a small helper for EvenHub apps that want to use
[Faceclaw](https://github.com/jimrandomh/faceclaw)'s extension APIs.

Faceclaw is an alternative host for EvenHub apps on the Even Realities G2
glasses. An app built against the standard
[`@evenrealities/even_hub_sdk`](https://www.npmjs.com/package/@evenrealities/even_hub_sdk)
runs in Faceclaw unchanged. This package lets the app detect that it is
running in Faceclaw and use some extra capabilities there: a taller canvas,
choice of fonts, the glasses' compass and buzzer, touch-down events and which device an input came
from, dictated or typed text, control of the app's switcher icon and the screen
timeout, window lifecycle events, voice-assistant tools, and the user's API keys
(with their consent). In the stock Even app the extensions are absent, and the
app runs as usual.

- [API reference](docs/api/README.md)

## Install

```sh
npm install @faceclaw/evenhub-extensions
```

The package has no dependencies. It contains TypeScript types and one small
function, and ships as both an ES module and CommonJS.

## Quick start

```ts
import { getFaceclawExtensions } from "@faceclaw/evenhub-extensions";

const fc = getFaceclawExtensions();
if (!fc) {
  // Not running in Faceclaw: use only the standard EvenHub SDK.
} else {
  console.log("host:", fc.getVersion()); // e.g. "Faceclaw/0.8.2"

  // Pause work while the app isn't on screen.
  fc.addWindowLifecycleListener((e) => {
    if (e.type === "hidden") pause();
    if (e.type === "visible") resume();
  });

  // Beep.
  await fc.playBuzzer([
    { freq: 880, ms: 90 },
    { freq: 0, duty: 0, ms: 40 }, // a rest
    { freq: 1320, ms: 160 },
  ]);
}
```

`getFaceclawExtensions()` returns `null` everywhere except inside Faceclaw
0.8.3 or later: in the stock Even app, in the EvenHub simulator, in a browser,
and in Node.
Faceclaw installs the API before any page script runs, so you can call it at
startup. You don't need to wait for the bridge first.

## How it works

Faceclaw injects one global function, `window.getFaceclawExtensions`, into the
app's webview. Every extension method lives behind it. Faceclaw doesn't modify
the standard SDK, other globals, or any built-in prototype, so an app that uses
the extensions keeps working in any other host. `getFaceclawExtensions()` in
this package checks whether that global exists and calls it.

The one addition outside that global is data: Faceclaw adds a
`faceclawInputSource` field to the raw JSON of stock gesture events, which
`getInputSource()` reads. Stock apps ignore it.

## Checking for features

New members will be added over time, and an app may run in a Faceclaw build
that is older than the version of this package it was built against. Use
`apiVersion` to check before calling anything newer than level 1:

```ts
const fc = getFaceclawExtensions();
if (fc && fc.apiVersion >= 2) {
  // Safe to use members marked "@since apiVersion 2" in the reference.
}
```

Everything in this release is API level 1, which Faceclaw 0.8.3 and later
implement. Faceclaw 0.8.0–0.8.2 injected an incomplete, unversioned preview of
the API; `getFaceclawExtensions()` returns `null` there, so whenever it returns
the API, every level-1 member is present. If you use
`window.getFaceclawExtensions` directly, check that `apiVersion` is a number
before relying on it.

## TypeScript

The types are bundled; there is no separate `@types` package. Importing
anything from the package also adds the global to `Window`, so
`window.getFaceclawExtensions` is typed throughout your program.

If you use the global directly and never import the package, add it to
`compilerOptions.types` in your `tsconfig.json`:

```json
{ "compilerOptions": { "types": ["@faceclaw/evenhub-extensions"] } }
```

## API overview

The [API reference](docs/api/README.md) documents every member in full.

| Member | What it does |
| --- | --- |
| `apiVersion` | The extension API level the host implements, for feature checks. |
| `getVersion()` | The host's name and version, e.g. `"Faceclaw/0.8.2"`. |
| `returnToAppSwitcher()` | Give focus back to the app switcher, and keep running. |
| `quit()` | Close the app. Faceclaw treats the stock `shutDownPageContainer(1)` as "return to the switcher", so use this to really quit. |
| `addWindowLifecycleListener(fn)` | `visible` / `hidden` and `focused` / `blurred` events. |
| `getConfiguredApiKeys()` | Which services the user has keys for (names only). |
| `requestApiKeyAccess(services)` | Ask the user, on the glasses, to share those keys with the app. |
| `playBuzzer(steps)` | Play a tone sequence on the glasses' buzzer. |
| `addCompassListener(fn)` | Turn on the magnetometer and receive headings. |
| `createLayout(layout)` / `replaceLayout(layout)` | Build the page on the full 576×452 canvas, with no container limit, and optionally keep content across layouts. |
| `setAssistantTools(tools)` | Offer tools to Faceclaw's voice assistant. |
| `addTouchDownListener(fn)` | Hear the moment a finger touches the ring or watch, before the gesture is known. |
| `addTextInputListener(fn)` | Receive dictated or typed text: the app becomes a "Type Into App" destination. |
| `startVoiceInput()` | Open the voice dialog for the app. |
| `setWindowIcon(icon)` | Replace the app's switcher icon with a pixel buffer. |
| `setAttention(on)` | Show or clear the attention dot on the app's switcher icon. |
| `setKeepScreenOn(on)` | Stop the display from sleeping for inactivity while the app is in front. |
| `getFonts()` | List the font families available to text and list containers. |
| `measureText(text, font)` | Measure text in a font, to size or centre it. |

The package also exports `getInputSource(event)`, which tells you which device
(`ring`, `left-touchpad`, `right-touchpad` or `watch`) produced a stock gesture
event.

### Extended layout

`createLayout` and `replaceLayout` take the same `textObject` / `imageObject` /
`listObject` / `menuObject` shape as the stock `createStartUpPageContainer` and
`rebuildPageContainer`, so you can keep using the stock SDK's container
classes. The differences:

- The canvas is the full 576×452 app area instead of 576×288, and an image
  container can fill it (the stock limit is 288×144).
- There is no limit on the number of containers.
- A container with `preserve: true` keeps the content (text, pixels, or list
  items and selection) of the same-named container in the previous layout.
  Without it, the container starts blank.
- Text and list containers can use other fonts (see [Fonts](#fonts)).

```ts
import { ImageContainerProperty, TextContainerProperty } from "@evenrealities/even_hub_sdk";

await fc.createLayout({
  imageObject: [new ImageContainerProperty({ containerID: 1, containerName: "map", xPosition: 0, yPosition: 0, width: 576, height: 452 })],
  textObject: [new TextContainerProperty({ containerID: 2, containerName: "hud", xPosition: 16, yPosition: 16, width: 300, height: 40, content: "Ready", isEventCapture: 1 })],
});

// Later: move the HUD, keeping the map's pixels.
await fc.replaceLayout({
  imageObject: [{ containerID: 1, containerName: "map", xPosition: 0, yPosition: 0, width: 576, height: 452, preserve: true }],
  textObject: [{ containerID: 2, containerName: "hud", xPosition: 16, yPosition: 396, width: 300, height: 40, content: "Ready", isEventCapture: 1 }],
});
```

Keep using the stock `updateImageRawData` and `textContainerUpgrade` to update
content; they address containers by `containerID`. Once an app has used an
extended layout, its window stays at 576×452 for the rest of the session.

### Fonts

In an extended layout, text and list containers can set a `font` with a
`family`, `size` (in pixels) and `weight`. A `font` on the layout is the
default for all of them, and a container's own `font` overrides it field by
field. Without either, text is in the stock firmware font, as before.

```ts
await fc.createLayout({
  font: { family: "Inter", size: 22 },
  textObject: [
    { containerID: 1, containerName: "title", xPosition: 16, yPosition: 12, width: 544, height: 50, content: "Today", font: { size: 40, weight: "bold" } },
    { containerID: 2, containerName: "body", xPosition: 16, yPosition: 70, width: 544, height: 360, content: "...", isEventCapture: 1 },
  ],
});
```

Faceclaw bundles Roboto, Inter, Montserrat and Roboto Mono (weights 300, 400
and 700, any size from 6 to 128) and the bitmap font Terminus (sizes 12 to
32, weights 400 and 700). `EvenHub` is the stock font, at 20px only. Users
can install more fonts, and `getFonts()` lists everything available. An
unknown family falls back to Roboto, and the nearest available weight and
(for bitmap fonts) size are used.

`measureText(text, font)` returns the text's width and line height in a
font, so you can size containers or centre text. A list row is the font's
line height plus 12 pixels.

### Input sources and touch-down

The stock `eventSource` field can't tell the watch from the ring, and scrolls
don't carry it at all. Pass the event your `onEvenHubEvent` handler receives
to `getInputSource()` to find out which device it came from:

```ts
import { getFaceclawExtensions, getInputSource } from "@faceclaw/evenhub-extensions";

bridge.onEvenHubEvent((event) => {
  const source = getInputSource(event); // "ring", "left-touchpad", "right-touchpad", "watch" or null
});
```

It returns `null` when the source is unknown (some scrolls), for non-gesture
events, and outside Faceclaw.

A touch-down is the moment a finger lands on the ring or the watch's
touchpad, before Faceclaw knows whether it will become a tap, a scroll or a
hold. The interpreted gesture still arrives afterwards as the usual stock
event. Touch-downs suit games and other latency-sensitive input:

```ts
fc.addTouchDownListener(({ source, timestampMs }) => flap());
```

The glasses' own touchpads don't report touch-down.

### Text input

While the app has a text-input listener, Faceclaw offers it as the "Type Into
App" destination for its voice dialog, the phone keyboard and the watch. The
app can also open the voice dialog itself:

```ts
fc.addTextInputListener(({ text }) => addNote(text));

// For example, from a "Dictate" item in the app's menu:
const opened = await fc.startVoiceInput();
```

### Window icon, attention dot, and screen timeout

```ts
// Draw a 32x32 icon on a canvas, light on black, and use it in the app switcher.
fc.setWindowIcon(ctx.getImageData(0, 0, 32, 32));

// Flag new activity while the app is in the background; clear it when seen.
fc.setAttention(true);

// Keep the display awake while the app is in front (e.g. a teleprompter).
fc.setKeepScreenOn(true);
```

`setWindowIcon` takes `{ width, height, data }` with grayscale or RGBA pixels,
up to 256×256, so an `ImageData` works as is. Pass `null` to restore the
package's icon.

### Compass

Each `CompassReading` has several headings, all in degrees clockwise from north:

- `headingDegrees` is the raw reading. The magnetometer is in the right arm,
  which sits at a slightly different angle on every wearer, so this heading is
  only relative.
- `magneticHeadingDegrees` adds the wearer's calibration from Faceclaw's
  Compass app. `wearerCalibrated` says whether they have calibrated.
- `trueHeadingDegrees` also corrects for local magnetic declination. It is
  absent when Faceclaw doesn't know the phone's location.

Use `trueHeadingDegrees` when it is present, and otherwise
`magneticHeadingDegrees`. If `wearerCalibrated` is false, treat the heading as
relative, or let the user set their own zero.

Readings arrive only while the app is in the foreground. The sensor turns off
when the last listener unsubscribes.

### Voice-assistant tools

```ts
fc.setAssistantTools([
  {
    name: "set_bpm",
    description: "Set the metronome tempo.",
    parameters: { type: "object", properties: { bpm: { type: "number" } }, required: ["bpm"] },
    availability: "open", // or "foreground" (the default)
    handler: ({ bpm }: { bpm: number }) => {
      setTempo(bpm);
      return `Tempo is now ${bpm}.`;
    },
  },
]);
```

The assistant sees each tool under your package name, as
`app.<packageName>.set_bpm`. Whatever the handler returns is reported back to
the assistant. If it throws, the assistant gets the error message. A handler
has 10 seconds to finish before the assistant is told the tool timed out.
Tools are removed when the app closes; call `setAssistantTools([])` to remove
them sooner.

Tool names are 1–64 letters, digits, underscores or hyphens. `parameters`
must be an object schema (`type: "object"`) without a top-level `oneOf`,
`anyOf` or `allOf`, since that is what the assistant's model providers accept.
Faceclaw skips a tool that breaks these rules and logs a warning to the app's
console.

### API keys

`getConfiguredApiKeys()` tells you which services (`openai`, `anthropic`,
`soniox`, `elevenlabs`, `mapbox`) the user has keys for, without revealing the
keys. `requestApiKeyAccess(services)` shows a consent prompt on the glasses and
resolves with the keys the user agreed to share. If the user declines, it
resolves to `{}`. A grant lasts until the app closes.

## Stock APIs in Faceclaw

Faceclaw implements the stock SDK too. Some differences worth knowing:

- `getDeviceInfo()` and `onDeviceStatusChanged` report the real glasses:
  their serial number, whether they are connected and worn, the battery level,
  and whether they are charging. `isInCase` is the same as `isCharging`, since
  the G2 only charges in its case. Fields Faceclaw doesn't know yet (wear state
  before the glasses first report it) are left out.
- `shutDownPageContainer(1)` returns to the app switcher instead of asking to
  quit. Use `quit()` to really quit.

## Stability

This package is pre-1.0. Until 1.0 the API may still change. After that, changes
will only add new members, gated by `apiVersion`.

## License

MIT. Faceclaw itself is GPL-3.0, but this package is MIT-licensed so that apps
under any license can use it.
