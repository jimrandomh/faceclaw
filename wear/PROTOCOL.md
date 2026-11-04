# Watch ⇄ phone protocol

The Wear OS and Apple Watch apps speak the same messages over different
transports, and `app/g2/wear-remote.ts` gives them their meaning on both phones.
This document describes the messages and the Wear OS transport; see "Apple Watch
transport" at the end for what differs there.

Transport: the Wearable Data Layer (Google Play services). Both apps share the
`com.faceclaw.app` application id and, for release builds, the signing key —
the Data Layer routes only between matching apps. Payloads are UTF-8 JSON
objects. Phone side: `App_Resources/.../FaceclawWearBridge.kt` (transport),
`app/native/wear-bridge.ts` (JS wrapper), `app/g2/wear-remote.ts` (meaning).
Watch side: `app/src/main/kotlin/com/faceclaw/wear/Protocol.kt`, `PhoneLink.kt`.

Capabilities (`res/values/wear.xml` on each side): the phone advertises
`faceclaw_phone`, the watch `faceclaw_watch`. Each side finds the other with
`CapabilityClient.getCapability(…, FILTER_REACHABLE)`.

Every watch → phone message except `/faceclaw/battery` and `/faceclaw/press`
carries `seq` (monotonic per watch process) and is answered on `/faceclaw/ack`.

## Watch → phone (MessageClient)

| Path | Payload | Effect |
| --- | --- | --- |
| `/faceclaw/input` | `{gesture, steps?}` | A ring gesture through the same path as the phone UI's test buttons. `gesture` ∈ `click`, `double-click`, `scroll-up`, `scroll-down`, `long-press` (complete short hold), `long-press-start`, `long-press-release`, `short-then-long-press` (tap then hold: the app's context menu; a plain `long-press` is the glasses' system menu), `wakeword` ("Hey Even"), `swipe-up`, `swipe-down`, `swipe-left`, `swipe-right` (spatial input only a watch can produce: delivered to the glasses UI as `swipe-*` events for components that navigate spatially — launcher grid, settings columns, sidebar, Music — with a scroll / click / double-click fallback elsewhere). `steps` (1–12) repeats a scroll. Refused while the glasses are disconnected. The lock screen is honoured exactly as for the ring. While the display is off, a double-click wakes the display, a `click` shows the phone's Glanceboard for a few seconds, and `long-press-start`/`long-press-release` hold it up; everything else is ignored. |
| `/faceclaw/press` | none | A finger landed on the pad (each first-finger touch-down, the second tap of a double-tap included) or the stem button went down: delivered on the glasses as a `ring-press` from source `watch`, exactly like the R1 ring's touch-down, ahead of whatever gesture the touch becomes (which is still sent on `/faceclaw/input`). Components that act on touch-down (Flappy, Pinball) then ignore the gesture that follows. Sent only while the mirrored state says the glasses are connected with the display on. Carries no `seq` and is never acked; the phone drops it silently wherever the following gesture would be refused. |
| `/faceclaw/command` | `{command, …}` | `launch-app {appId}`, `focus-window {windowId}`, `close-window {windowId}`, `sidebar`, `wake`, `sleep`, `lock`, `unlock`, `connect`, `disconnect`, `close-assistant`. Everything but connect/disconnect needs a connection; everything but lock/unlock is refused while locked; `unlock` also needs the phone's "Watch can unlock glasses" setting. |
| `/faceclaw/assistant` | `{text}` | Send a query to the assistant (`shell.sendToAssistant`) — the reply shows on the glasses and streams back to the watch as events. |
| `/faceclaw/text` | `{text}` | Type text into the foreground window (`receiveTextInput`, e.g. the terminal). Refused when the window doesn't take text. |
| `/faceclaw/state/request` | `{}` | Re-publish the state item even if unchanged. |
| `/faceclaw/battery` | `{battery, charging}` | The watch's own battery (`battery` 0–100 or null, `charging` bool) for the glasses' top-bar and Glanceboard "Watch" indicator. Sent in answer to `/faceclaw/battery/request` by `PhoneListenerService` (which Play services starts even while the watch app is closed) and, while the app is open, whenever the level or charging state changes. Carries no `seq` and is never acked. |

All of the above except `state/request`, `battery` and `press` are refused
with `ok:false` when the phone's "Watch remote control" setting is off (a
`press` is just dropped).

## Phone → watch

`/faceclaw/ack` (MessageClient, to the sender):
`{seq, ok, jsReady, message}`. `jsReady:false` means Play services started the
app process for the message but the JS dashboard isn't up (the user has not
opened Faceclaw since boot); the watch shows "Open Faceclaw on the phone".

`/faceclaw/battery/request` (MessageClient, to every reachable watch): `{}`.
Please send `/faceclaw/battery` now. The phone sends it when a watch becomes
reachable, when the glasses connect with the level still unknown, and every
5 minutes after that; the indicator disappears when no watch is reachable.

`/faceclaw/event` (MessageClient, to every reachable watch):
- `{type:"assistant", phase, text}` — `phase` ∈ `thinking`, `streaming` (text so
  far, replace semantics, ≤ 4/s), `done` (final text), `error` (message),
  `closed` (overlay dismissed).
- `{type:"alert", text}` — a `glasses.show_alert` popup.
Both are gated by the phone's "Mirror assistant to watch" setting.

`/faceclaw/state` (DataClient item, keys `json` and `updatedAt`): the mirrored
dashboard state, re-sent whenever it changes (and at least every 30 s):

```json
{
  "protocol": 1, "version": "…",
  "phase": "connected", "status": "…", "connected": true, "preview": false,
  "screenOn": true, "locked": false, "worn": true, "listening": false,
  "battery": 78, "charging": false, "silentMode": false,
  "caseBattery": 64, "caseCharging": true,
  "foreground": {"appId": "music", "title": "Music"},
  "windows": [{"windowId": "…", "title": "…", "appId": "…", "focused": true, "closeable": true, "acceptsText": false}],
  "apps": [{"appId": "timer", "title": "Timer"}],
  "remoteEnabled": true, "crownClockwiseNext": false,
  "canUnlock": true, "mirrorAssistant": true,
  "assistantAvailable": true
}
```

`battery` is the current or last-known G2 percentage. `charging` and
`silentMode` identify the two states in which the glasses display is not
visible even though the BLE session remains available.

`caseBattery` is the last-known charging-case percentage, or null until the
glasses have reported one; the case only reports while the glasses are docked,
so outside charging it can be stale. `caseCharging` is whether the case is on
USB, or null while the glasses are out of the case (they can't see it then).
The watch shows the case level under the charging line.

`protocol` is reserved for incompatible revisions of this format (nothing
checks it yet). `crownClockwiseNext` mirrors the
on-glasses Settings > Watch toggle; when false (the default), clockwise crown
rotation sends previous/up, and when true it sends next/down.

`apps` is the launcher grid plus installed EvenHub packages, i.e. exactly what
the assistant's `apps.launch` tool accepts.

`preview` says gestures are landing on the phone's own display preview, with no
glasses involved: `connected` stays false, but input isn't refused. Only the iOS
app sets it for now.

## Apple Watch transport

Transport: WatchConnectivity. Phone side:
`App_Resources/iOS/src/FaceclawWatchBridge.m` (transport),
`app/native/wear-bridge.ios.ts` (JS wrapper). Watch side:
`apple-watch/Faceclaw/PhoneLink.swift`, `Protocol.swift`.

The system only links the two apps when the watch app's
`WKCompanionAppBundleIdentifier` names the phone app, its bundle ID begins with
the phone app's, **and the phone app's bundle embeds it in `Watch/`**; installing
each app separately leaves both sides reporting the other as not installed. See
`apple-watch/README.md`.

A message is a dictionary `{path, json}`, where `json` is the JSON payload above;
every path and payload is unchanged. `sendMessage` is used with no reply handler,
and acks are ordinary `/faceclaw/ack` messages. What differs follows from one fact:
**the phone can't wake the watch app, and the app is suspended whenever the wrist
drops.** The watch can wake the phone app, and does so with any message.

| Wear OS | Apple Watch |
| --- | --- |
| `/faceclaw/state` is a Data Layer item | The application context, `{json, updatedAt}`, for the app's next wake. While the app is in front it's also sent live as `{path: "/faceclaw/state", json, updatedAt}`, since context delivery can lag. Whichever `updatedAt` is newer wins. |
| `/faceclaw/event` is lost if the app is closed | Also sent live, with `at`. All but `streaming` snapshots also stay in the context as `{event, eventAt}`, so a reply that finished with the wrist down is there on the next raise. The watch drops anything not newer than the last `at`, and ignores a stale context event (assistant after 10 minutes, alert after 1). |
| `/faceclaw/battery/request` wakes a listener service | Only reaches an app in front. The app reports on open, every minute while open, and when the system grants it background time (asked for every 30 minutes), leaving `{battery: <json>}` in its own context for the phone to find. The payload adds `at` (ms), and the phone treats a level over 4 hours old as unknown. |
| "Reachable" is a capability query | `isPaired && isWatchAppInstalled`, whether or not the app is running. Live reachability changes also fire the connection callback, which is what pushes fresh state to an app coming to the front. |
| `nodeId` routes acks | Unused: a session has one counterpart. |

`isReachable` lags a moment behind a wrist raise, so the watch holds gestures for up
to 1.5 s rather than failing them. Touch-downs (`/faceclaw/press`) are never held.
