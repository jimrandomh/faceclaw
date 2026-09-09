# Typed SDK events

SDK 0.3.0 adds `onHostEvent(HostEvent event)` for Java and Kotlin. Existing
`onHostEvent(String, JSONObject)` implementations continue to receive events
through the default typed callback. Override one overload. Calling `super` from
a typed implementation forwards the event to the legacy overload; it does not
perform additional authorization.

The SDK authenticates the host, session and applicable message authority before
calling the app. Typed decoding adds no permissions. `HostEvent.decode` is also
available for synthetic JVM tests; decoding a test event does not authorize a
real action. Callbacks remain on the main looper.

| Type | Fields and purpose |
| --- | --- |
| `Window` | Open/resize: `width`, `height`, `generation`, `target`, `isOpen()`. |
| `Visibility` | `visible`, `screenOn`. Allocate frames only when both are true. |
| `Input` | `inputType`, `source`, optional pointer `x`/`y`, `isClick()`. |
| `Capabilities` | Explicit boolean grants/support and negotiated limits; missing grants are false. |
| `Extensions` | Full snapshot `revision`, immutable `features`, lookup by feature ID. |
| `Feature` | Selected `component`, feature `generation`, `available`, `live`, copied configuration, immutable ordered `contenders`, `contender(component)`. |
| `Contender` | `component`, one-based `priority`, `enabled`, `granted`, `connected`, immutable `requires`, `reason` enum and original `reasonCode`. |
| `ExtensionsRejected` | Publication `reason`; previously accepted declarations remain intact. |
| `Surface` | Feature, phase, surface generation, optional dimensions and feature epoch on open/resize. |
| `Provider` | Feature, feature generation, phase, request ID, optional deadline, common request/result fields. |
| `Style` | Font, raster and optional numeric typography tokens. |
| `Configure` | App setup endpoint and one-time code. Never log or retain the code. |
| `NotificationReply` | Current notification ID, target, consumed reply token, reviewed text and confirmation. |
| `CaptureStatus` | Request ID, status/reason for capture status and closure. |
| `TextResult` | Request ID, target, text, confirmation/finality and distinct `TextPurpose`. |
| `Rejected` | Request ID and displayable reason for dictation/search/refinement rejection. |
| `Signal` | Render, close and app-menu callbacks. |
| `Unknown` | Future or malformed typed shapes; ignore unless intentionally using the legacy API. |

Events hold immutable snapshots. `data()`, `configuration()` and `payload()`
return copies. `toString()` excludes payloads. Do not log those copies: events
can contain private text and tokens. Notification fragments and arbitrary tool
arguments retain their documented JSON API in
this release. Do not treat `Unknown` as a request or confirmation.

## Window lifecycle

Use `WindowState` to share the same lifecycle logic between a service and its
JVM tests. Feed each typed event to `accept`, call `disconnect()` from
`onHostDisconnected`, and check `canDraw()` before allocating a bitmap. Open
waits for visible/awake state. Resize updates dimensions and generation. Hide,
sleep, close and disconnect stop drawing. This does not replace animation
cancellation or authorization checks for backend work.

```java
private final WindowState window = new WindowState();
@Override protected void onHostEvent(HostEvent event) {
    window.accept(event);
    if (!window.canDraw()) return;
    // Allocate using window.width()/height(), draw, submit and recycle.
}
@Override protected void onHostDisconnected() { window.disconnect(); }
```

The standalone starter has executable consumer tests in
`app/src/test/java/.../LifecycleTest.java`. Run `:app:testDebugUnitTest` without
a phone. Replay only synthetic data with `HostEvent.decode`.

## Provider requests and late work

`Extensions.revision` describes the full settings snapshot.
`Provider.generation` and `Feature.generation` identify one feature's authority.
Never substitute the full revision or a surface stream generation for that
feature epoch. `Provider.deadlineAt` is the host's epoch-millisecond deadline.

Use a `ProviderRequests` instance per service connection. Feed every event to
`accept`, use `begin` before starting work, and call `complete` once before
submitting the final result. Feed cancellation and extension updates even when
the app window is hidden. Clear the tracker on disconnect. Completion rejects
expired, cancelled, replaced, unavailable and already-consumed work. An
unrelated feature/snapshot change preserves an unchanged feature's request.

Transcription requests also expose `ownCapture`, `captureId`, `sampleRate`,
`format`, `maxBytes`, and streamed `pcmBase64`. An app-owned capture may run
without winning global transcription. The tracker therefore uses its feature
epoch and explicit cancellation, not the global winner's availability, for
`ownCapture` requests. The app must still enforce its capture ID and grant.

```java
private final ProviderRequests requests = new ProviderRequests();
@Override protected void onHostEvent(HostEvent event) {
    requests.accept(event);
    if (!(event instanceof HostEvent.Provider)) return;
    HostEvent.Provider request = (HostEvent.Provider) event;
    if (!request.feature.equals("assistant") || !request.isRequest()) return;
    if (!requests.begin(request, System.currentTimeMillis())) return;
    // This example has not called a backend. It explicitly reports that fact.
    if (requests.complete(request, System.currentTimeMillis()))
        respondExtension(request, ProviderResult.unavailableBeforeDispatch());
}
@Override protected void onHostDisconnected() { requests.disconnect(); }
```

For asynchronous work, marshal completion back to the main looper. Also cancel
your network task and release private buffers on cancellation/connection loss;
the tracker only prevents stale completion. Trackers are not thread-safe.

`ProviderResult.success(text)` supports assistant/refinement/transcription
results, including an authoritative empty transcription. Use
`unavailableBeforeDispatch()` only when no backend operation was dispatched.
Use `unknownOutcome()` when dispatch or completion is uncertain. Never retry or
switch providers automatically after an uncertain outcome. The return value of
`respondExtension` means transport submission, not host acceptance or successful
backend work. Recheck account/project authorization in the application.

`TextPurpose.SEARCH` authorizes a local query only. `CAPTURE` and `REFINEMENT`
contain draft text. Only the separately documented message-review flow can
confirm a message, and the app must still match the request, target and current
account. A typed result does not combine these purposes.

## Explain conflicting settings

Use `Feature.contender(component)` to find your service, using its full Android
component name. `contenders` preserves the host's priority order, including
ungranted and disabled candidates. Position alone is not ownership. Use the
feature's selected component and availability together with each contender's
`ContenderReason`: `ACTIVE`, `LOWER_PRIORITY`, `DISABLED`, `GRANT_REQUIRED`,
`DEPENDENCY_OWNER`, `DEPENDENCY_UNAVAILABLE`, `DISCONNECTED`, `INCOMPATIBLE`,
`UNDECLARED`, or `UNKNOWN`. `requires` identifies the dependencies to explain.

Older snapshots without contenders decode to an empty list; that does not mean
permission was granted. Future reason codes decode to `UNKNOWN` and preserve
`reasonCode` for deliberate future handling. Malformed boolean/list shapes do
not become typed authority. Lists are immutable and diagnostic strings omit
component identities. A disconnected static contender may still be active.

The complete [conflict status example](examples/ConflictStatusAppService.java)
publishes a typography candidate and explains its typed state without parsing
callback JSON. The standalone example build includes this service. Feature
permission and priority remain host-owned; an example cannot grant itself access.
