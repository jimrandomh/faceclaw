# Faceclaw Android application SDK

Install applications as ordinary Android APKs. Faceclaw discovers an exported application service, asks the user to approve the installed package/signers, and binds it without loading its code. Each app keeps Android permissions and data under its own UID. The app's SDK asks the user to select one verified host. Switching hosts clears the old host's sessions, app approval, notification cache, and capability grants; it does not revoke the app's separate backend account credential.

New app approvals default notifications, dictation/review, message text previews and declared-source suppression to enabled. The approval dialog shows these choices before the user confirms. Defaults are written with the initial approval, not applied as runtime fallbacks: upgrades and reapproval of an existing record preserve explicit choices and legacy missing-key behavior. Discovery and phone setup Intents never grant capabilities. Revoking approval clears its settings; a later fresh approval uses the new defaults. Source suppression still requires a declared source and a connected approved app.

## Build and consume

Requires Android SDK 35 and JDK 17 or newer for Gradle. The Java API targets Java 11, Android 24+, AGP 8.9.2. Build from this directory:

```sh
./gradlew :sdk:assembleDebug :sdk:testDebugUnitTest :sdk:lintDebug
```

An Android application may include this build in `settings.gradle.kts`:

```kotlin
includeBuild("../faceclaw-app-platform/android-sdk")
```

Then depend on `implementation("com.faceclaw:sdk:0.1.0")`. This is a source-coupled preview: build host and clients from the same SDK checkout. The `0.1.0` coordinate and `extensions: 1` capability do not distinguish preview revisions; version/capability negotiation must be settled before independently distributed releases. Public artifact publication is a separate release task. Faceclaw's NativeScript build compiles the same SDK Java sources through `App_Resources/Android/app.gradle`.

Declare one service extending `com.faceclaw.sdk.FaceclawAppService`:

```xml
<service android:name=".GlassesService" android:exported="true">
  <intent-filter><action android:name="com.faceclaw.action.APP_SERVICE" /></intent-filter>
  <meta-data android:name="com.faceclaw.PROTOCOL_MAJOR" android:value="1" />
  <!-- Optional: enables the host's HTTPS endpoint / one-time code setup form. -->
  <meta-data android:name="com.faceclaw.CONFIGURATION" android:value="bridge" />
  <!-- Optional: one declared source the user can explicitly suppress on glasses. -->
  <meta-data android:name="com.faceclaw.SUPPRESS_PACKAGE" android:value="example.original.app" />
</service>
```

The SDK manifest merges its non-exported host-selection activity. SDK approval stores are bound to a marker in Android no-backup storage: restoring preferences without the installation marker clears grants. Apps must separately protect their own credentials, message caches, and backup policy. Do not export a service that exposes private functionality through a second unauthenticated interface.

## Phone setup entry points

An app should provide its own Android launcher Activity for settings and connection status. **Manage Android applications** opens that app's phone interface when its row is selected. To declare a dedicated entry point, add an intent filter for `com.faceclaw.action.APP_SETTINGS` and category `android.intent.category.DEFAULT` to an exported settings Activity. The host resolves only enabled, exported, unprotected activities in the installed service's package and UID, then sends an explicit Intent with no extras. A validated launcher Activity is the fallback. An app without either entry point gets an explanation and a link to its host permissions. Keep credential entry in that app's private configuration path; public settings Intents must not configure credentials or authorize a host from caller-provided extras.

The manager's **Permissions and priority** button keeps app approval, host selection, individual capability grants and global feature priority in Faceclaw. Apps can link back to those controls with the following host entry point; opening app settings itself never changes authority.

Current Faceclaw hosts advertise an Activity for `com.faceclaw.action.MANAGE_APPS`. An app can declare that action under its manifest `<queries>`, discover available hosts, and launch the selected Activity with an explicit component. The optional `appPackage` string is only a navigation hint: the host validates it, discovers installed app services itself, and shows its normal approval controls. Opening this Activity never grants app approval, selects a host, or enables capabilities automatically. Older hosts can still be configured through **Settings > Installed apps > Manage Android applications**.

The SDK exposes the selected host package, its verified installed status and its friendly application label for an app's local setup UI. Saved host selection is not proof of an active connection. Bridge pairing and backend availability remain the individual app's responsibility.

## Authoring

The [Kotlin Canvas example](examples/CanvasAppService.kt) shows a complete service mixing Android drawing with Faceclaw helpers, handling viewport/visibility changes and ring clicks. Copy it into an Android app that depends on this SDK and declare its service as above. It uses the SDK's normal host approval flow.

Override `onHostConnected()`, `onHostDisconnected()`, and `onHostEvent(String, JSONObject)`. Callbacks run on the main looper. `submitBitmap(Bitmap)` copies the bitmap synchronously and must also run on the main looper; recycling after return is safe. Handle `render` and visible `visibility` events to submit the first frame after opening. Pause animations when hidden/asleep, but keep approved background message receiving independent of the visible window.

Use ordinary Canvas drawing, optional `Ui.text`, `Ui.card`, `Ui.wrap`, and `Ui.layers` helpers, or mix them. `Ui.layers` composites ordered ARGB bitmaps using standard Canvas source-over alpha against black; submission converts the final result to grayscale. Pixel 1 represents opaque black and 255 white. This version sends pixels for both styles; it has no remote glyph-cache commands. The host owns its shell, viewport, BLE link, sleep policy, reserved gestures, and final incremental display updates.

Use the [shared window-motion contract](WINDOW_MOTION.md) and `WindowAnimator` / `Ui.transitionCard` for standard card and notification transitions. Java and JavaScript helpers preserve T3 timing, defer opening body rendering until 90%, clear body pixels before closing, and support immediate reversal. The contract includes runnable authoring examples and parity fixtures. Adoption is optional.

`FrameAnimator` is an optional main-thread clock for app-owned transitions. Construct it with a progress callback, call `start(durationMs)`, and render/submit your own bitmap for each callback. It emits eased progress from 0 to 1 at intervals of up to 40 ms; delivery can be slower under load. Call `cancel()` when hidden, disconnected, resized, or when the source content becomes invalid. A callback can safely cancel or replace its own animation. It does not retain scene bitmaps or guarantee display frame rate.

| Host event | Data |
| --- | --- |
| `capabilities` | Current `notifications`, `dictation`, `previews`, optional `notificationReplies`, plus `maxWidth`, `maxHeight`, `maxText`, `maxNotificationText`; handle again when grants change |
| `open` | `width`, `height`, `generation`, opaque `target` (empty for launcher entry) |
| `resize` | `width`, `height`, new `generation` |
| `input` | Existing Faceclaw `type`, timestamp and input source |
| `visibility` | `visible`, `screenOn` |
| `render`, `close` | Empty object |
| `configure` | HTTPS `endpoint`, short-lived single-use `code`; exchange in the app, never log/save the code |
| `dictation-result` | `requestId`, opaque `target`, exact reviewed `text`, `confirmed: true` |
| `dictation-rejected` | `requestId`, displayable `reason` |
| `notification-reply` | `id`, opaque `target`, `replyToken`, exact reviewed `text`, `confirmed: true` |

Ring input includes `scroll-up`, `scroll-down`, `click`, and `double-click`; the shell reserves system gestures. The viewport is negotiated on each open/resize; never assume 576×288. Typical default content is 576×260 after shell chrome. The maximum supported allocation is 640×480.

`postNotification(id,target,title,text,expiresAtMs)` and `removeNotification(id)` require the user's notification grant. Limits: ID 128, target 512, title 160, body 4096 characters; 32 active entries per app and 128 total. Notification bodies stay in memory, expire no later than 30 days or the supplied earlier time, and disappear on disconnect/revocation. Set the earlier true message expiry and withdraw deleted content. Do not replay synchronized backlog as new alerts. Message previews default to sender/text; users can choose sender-only. Alerts enter Faceclaw's existing popup, inbox, and tray. Opening an alert passes its opaque target to the same app. App notification content is excluded from Faceclaw's generic assistant notification tools; assistant access belongs to the backend's separate grants.

Hosts may replace their notification presentation without changing an APK. To support replies from a host notification reader, check the negotiated `notificationReplies` capability and publish with `postNotification(id,target,title,text,expiresAtMs,replyToken)`. Use a new opaque, unguessable token of at most 128 characters for each actionable publication/revision. Empty or omitted tokens leave the notification with only its Open conversation action. Replies require both notification and dictation grants. Older hosts that do not advertise this feature remain usable without notification replies.

The host owns dictation and the explicit Send review. A `notification-reply` event contains that exact reviewed text, up to 8000 characters. The SDK consumes the current published token once before delivering the event. The app must additionally verify its source content, account, conversation, expiry and current authorization, then use its normal draft/send path. This event can arrive while the app's own window is hidden; it must not require opening that window or a second Send review. Replacing/removing a notification, losing authorization or switching hosts invalidates its action.

Report one final outcome with `reportNotificationReplyResult(id,replyToken,status)`, where `status` is `sent`, `draft-saved`, `unknown` or `rejected`. Use `sent` only after your transport confirms the send; it does not mean recipient delivery or read. Save offline drafts without automatically sending later. The host initially displays submission, applies a 20-second result deadline, and treats a missing result as unknown. Results for stale, removed, foreign or already completed actions are ignored. Unknown outcomes must never trigger an automatic retry.

`requestDictation(requestId,target,label[,initialText])` requires a dictation grant and a recent user gesture in that app's visible window. It returns local acceptance; handle `dictation-rejected` as well. Existing drafts up to 8000 characters open at review without starting the microphone. The host shows a single explicitly named Send action, never auto-sends, and returns the exact text only after user selection. Cancel pending reviews via `cancelDictation(requestId)` when the account, target, source message, or authorization changes. Closing/hiding/locking the window or revoking access cancels host review. The backend must still enforce its account/conversation and operation authorization at dispatch.

## Voice search

Hosts may advertise `searchDictation: true` in their capabilities. With that support and the dictation grant, an app can call `requestSearchDictation(requestId, target, label)` from a recent gesture in its visible window. The host records an authoritative final transcript and presents **Search**, **Try again** and **Cancel**. It has no message destination, send action or draft refinement.

Handle `search-dictation-result` with `{requestId,target,text,confirmed:true}` as a local query only. Queries are nonempty and limited to 256 characters. Match the current request, target and app state before consuming the result once. Handle `search-dictation-rejected` for unavailable or cancelled searches, and call `cancelSearchDictation(requestId)` when leaving the search state. Search and message-review events and cancellation purposes are distinct; a search result must never authorize a message send. The host cancels search on lost visibility, revoked dictation access, screen lock or connection loss.

## Protocol and trust boundary

Messenger control messages use Android's actual `Message.sendingUid`, an unambiguous package identity, the current complete signing set, an unguessable connection session, and a negotiated major version. Shared-UID packages are rejected. Approvals are specific to the Android user/UID, package, component, and signing identity. A signature or installation identity change invalidates approval. Controls are limited to 65536 UTF-16 characters. External code cannot obtain host native objects, foreign notification actions, host BLE access, or backend credentials.

Each frame has negotiated dimensions, monotonically increasing sequence, and window generation. Android 27+ uses `SharedMemory`, read-only in the sender after writing; the host always copies into private memory before native composition, including with malicious senders. Android 24–26 has a bounded byte-array fallback. Maximum frame size is 307200 bytes. The SDK keeps one in-flight frame and coalesces to one pending frame. The host keeps at most one private pending snapshot per app window or extension surface and presents the newest frame at the next 16ms boundary, including the final frame after rendering stops. An ACK releases the sender after validation and private copying; it does not imply that presentation has already occurred. Hidden, asleep, closed, resized, revoked, replaced and disconnected scopes cancel pending snapshots; delayed delivery rechecks current ownership and generation. Hosts reject abusive message rates. These are memory/queue bounds, not measured performance guarantees.

Source suppression is an explicit per-app host grant, restricted to the package declared in the manifest and the host's current Android profile. It changes only glasses presentation; underlying official notification preferences and phone notifications remain untouched. Host connection loss releases the temporary suppression. Disabling a separate assistant grant must never disconnect this app.

## Verification fixtures

`fixture` and `host-tests` are disposable synthetic APKs, excluded from the production SDK artifact. The fixture authorizes only known test host packages with its own debug signer through a fixture-only setup service; never ship these test subclasses in a product. The tests exercise real separate-UID Messenger IPC, SharedMemory drawing, hidden/asleep rendering, malformed/stale frames, capability rejection, revoked signer pins, and forged sender identity.

```sh
./gradlew :fixture:assembleDebug :host-tests:assembleStandaloneDebug :host-tests:assembleStandaloneDebugAndroidTest
adb -s emulator-5554 install -r fixture/build/outputs/apk/debug/fixture-debug.apk
adb -s emulator-5554 install -r host-tests/build/outputs/apk/standalone/debug/host-tests-standalone-debug.apk
adb -s emulator-5554 install -r host-tests/build/outputs/apk/androidTest/standalone/debug/host-tests-standalone-debug-androidTest.apk
adb -s emulator-5554 shell am instrument -w com.faceclaw.sdk.hosttest.test/com.faceclaw.sdk.hosttest.BoundaryTest
```

The parent repository's `npm test` covers notification expiry, namespace isolation, retention, and bounded cache behavior. Physical glasses performance, manufacturer background restrictions, and side-by-side host switching also require device acceptance before release.

The `upstream` and `t3` instrumentation flavors target already-installed, debug-signed Faceclaw APKs. Build only their `assembleUpstreamDebugAndroidTest` / `assembleT3DebugAndroidTest` tasks and install only the resulting **androidTest APKs**. Never install those flavors' stub application APK over a real Faceclaw install. The tests touch only synthetic fixture grants, preserve other app approvals, and report submission-to-private-frame-copy timing from a monotonic timestamp encoded in synthetic pixels. That timing includes SDK grayscale conversion, IPC and host authorization; it excludes BLE delivery and the display panel.

## Global customizations and providers

The [independent priority demos](priority-demo/README.md) provide two installable SDK applications, an emulator test runner, and a [phone/glasses checklist](priority-demo/DEVICE-CHECKLIST.md). They exercise declaration changes, competing owners, offline revocation, dependencies and stale replies without T3 or a backend.

Hosts advertising `extensions: 1` accept `publishExtensions(JSONArray)` declarations. Each item has `{feature, enabled, configuration, requires?}`. Declaration publishes an app-owned candidate; it does **not** grant permission, change another app's toggle, set priority, or write a host preference. The host's **Global customizations and providers** screen grants each feature separately and lets the user move contenders to the top of that feature's priority list. New contenders append below existing choices. Eight installed app owners may publish declarations at once.

The known features are `ui.launcher`, `ui.navigation`, `ui.app-menu`, `ui.window-layout`, `ui.typography`, `ui.notifications`, `assistant`, `transcription`, `refinement`, `device-tools`, and `notification-content`. Bundles may partly win. `requires` lists other features that must also be won by the same app; missing/cyclic declarations are rejected. An enabled, approved loser becomes active when the winner is disabled, revoked, or removed. An ordinary live-service outage keeps the selected winner and falls back to host behavior. Persistent navigation/layout/type configuration remains effective while its signed app is installed and approved, unless it depends on an unavailable live feature. No override edits underlying host settings.

Each feature's `generation` is its authority epoch. It changes when that feature's selected owner, configuration, effective availability or declared dependency state changes. Unrelated contenders and feature changes do not invalidate an unchanged winner's requests, surfaces or reviews. Revocation invalidates effective configuration even if its app is already disconnected. The top-level snapshot `generation` is a revision for the complete settings snapshot and may change without changing a particular feature's epoch. Use the feature epoch for `extension-event` replies/actions and `extensionGeneration` on surfaces; do not substitute the top-level revision. Own-window notification fragments retain their explicitly supplied snapshot generation. SDK clients should retain unaffected surfaces and partial feature snapshots across unrelated updates.

Configurations have closed typed schemas. Unknown fields, values and feature IDs are rejected:

| Feature | Optional configuration |
| --- | --- |
| `ui.launcher` | `label`; `filesDefaultView`: `icons` or `list` (only when Files has no explicit saved preference) |
| `ui.navigation` | `rootBack`: `sleep`/`switcher`; `tapHold`: `switcher`/`app-menu`; `hold`: `app-menu`/`system-menu`; `wakeFocus`: `window`/`sidebar` |
| `ui.window-layout` | `centered`, `ownTopBar`: boolean; `sidebarMode`: `overlay`/`persistent`; `switcherHeight`: `display`/`minimum`; `dividerWidth`: 1–4; `ownHeightMode`: `min`/`medium`/`max` (own APK window only); `inputDialogs`: `compact`/`viewport` |
| `ui.typography` | Bundled `font` filename; integer `size` 8–20; `raster`: `antialiased`/`crisp`/`hinted`; `borderWidth` 1–4; `selectionBorderWidth` 1–5; `cardRadius` 0–24 |
| `ui.app-menu` | `title`, `systemTitle` (100 characters); `displayOffFirst`, `systemActionsLast`: boolean |
| Other features | Optional `label` (100 characters) |

`extensions()` returns the last `extensions` event snapshot: `{version,generation,features:[{feature,component,configuration,live,available,generation,contenders}]}`. Contenders include `enabled`, `granted` and `connected`. Display superseded state from this snapshot; do not mistake a saved toggle for effective control. Signing/UID changes, restored-backup grants, host switching and approval revocation invalidate authority. Generation changes invalidate outstanding requests and surface streams. External APKs never receive host Java objects, arbitrary settings setters, BLE handles, foreign `PendingIntent`s, or another app's reply token.

### Provider requests and global surfaces

`onHostEvent("extension-event", {feature,generation,type,data})` delivers host `request`, `event`, `cancel`, and `input` messages. Reply once with `respondExtension(feature,generation,requestId,data)`. Stream bounded progress with `reportExtensionProgress(...)`. The host accepts replies/progress only for a pending request issued to that owner in the current session/generation. Deadlines are 10 minutes for assistant turns, 390 seconds for transcription, 120 seconds for refinement, and 20 seconds otherwise. Cancellation never authorizes replay. Assistant failure or disconnect after dispatch reports an uncertain outcome; only a stated pre-dispatch failure may select the host fallback.

Assistant requests contain `{requestId,text}`. Progress contains complete `text` and optional `activity`; final data contains `text`, `stopReason`, and optionally `error`/`dispatched`. Refinement requests contain `{requestId,original,followup}` and return `{text}` or `{error}`. Transcription requests specify `operation:"start"`, 16 kHz `pcm_s16le` and a 9,600,000-byte limit. Audio events contain `event:"audio"`, the matching `requestId`, and `pcmBase64` with at most 4096 decoded bytes; `event:"finish"` ends capture. Progress is partial text; the final response's `text`, including an empty string, is authoritative. Discard buffered PCM on cancellation and do not persist it.

The launcher, app-menu and notification roles can render independent surfaces. `extension-surface` events carry `{feature,type,width,height,generation,extensionGeneration,visible,screenOn}` as applicable. Draw with `submitExtensionBitmap(feature, bitmap)` on the main looper. Each feature has independent dimensions, stream generation, sequence, one in-flight frame and one coalesced pending frame. Frames are accepted only for the winning visible awake surface and are copied privately before rendering. Transparent ARGB pixels become zero for extension surfaces; opaque black remains pixel 1. Ordinary app-window submissions remain opaque.

Use `invokeExtensionAction(feature,generation,action,data)` for semantic host actions. The immediate return indicates local submission only. Include your own bounded `callId`; await an `action-result` event for the result. UI navigation, menu selections and notification actions require a recent actual gesture on the corresponding surface. `close-surface` and owner-scoped review cancellation need no gesture. Recovery/system menus and Android phone settings remain host-owned.

Menu providers receive `{event:"menu",windowId,title,items:[{token,label,enabled}]}`. Submit `menu-select` with `{callId,token}`. Tokens are one-use, window/generation-bound and execute the host's captured menu callback; APKs never supply callback code.

Notification presentation is a separate explicit grant that discloses access to other apps' notification content. Snapshots arrive as `notification-snapshot-fragment` events with `snapshotId`, zero-based `index`, `total`, and `json` fragments. Reassemble only complete snapshots in the current generation, with at most 128 fragments and 2 MiB total; clear incomplete snapshots on disconnect. The assembled object contains `notifications` and `revision`. Keys are host aliases; APK-origin keys retain an `apk:` prefix, and conversation aliases preserve grouping without exposing destination or reply credentials. Opening/replying/dismissing requires the current opaque key and `postTime`. `notification-review-reply` starts a host-owned explicit Send review; the customization APK receives outcomes, never reviewed reply text. `notification-cancel-review` carries the original review `callId` and cancels only that owner's review. Source revision, lock, lost grants, or owner/generation changes cancel reviews.

`device-tools` has its own grant. Calls include bounded `callId`, `name`, object `arguments`, `issuedAt` and `expiresAt` (maximum two-minute window); duplicate calls are rejected. The original app/bridge must still enforce its project/account authorization. Generic notification tools exclude APK messages, even when the same app also owns notification presentation. Timeouts and uncertain action outcomes must never be retried automatically.

### Shared styles and app-owned dictation

A `shared-style` event contains the effective, validated typography configuration, including the host baseline when no override applies. The SDK applies it to `Ui.style()` before calling the app. Shared font files are bundled SDK assets, never paths supplied by another APK. Style state resets on disconnect/host revocation. Apps can use `sharedStyle()` for the negotiated values and redraw/re-measure on changes.

Ordinary approved apps receive `host-state` with the host's battery/weather and screen state independently of customization roles. `setWindowProtected(true)` defers arrival previews while that app's foreground window is editing a draft, plan or review; clear it when that state ends. It cannot protect another app's window.

Apps that provide their own capture/review UI may call `requestCaptureDictation(requestId,label[,ownTranscription])`, `finishCaptureDictation(requestId)` and `cancelCaptureDictation(requestId)`. Start requires the dictation grant and a fresh gesture in that app's visible window. `ownTranscription:true` additionally requires its separately granted transcription role, even if the global transcription toggle is disabled. The requester's provider sees `ownCapture:true` and the original `captureId`; match that ID to the current capture before accepting audio. Capture ends on hide, lock, grant loss, disconnect or timeout. `capture-dictation-transcript` returns `{requestId,text,isFinal,purpose:"capture"}`; this is draft content and never a confirmed send. Status and closure use `capture-dictation-status` and `capture-dictation-closed`. `requestSleep()` similarly requires a fresh gesture in the app's foreground window. `requestSystemMenu()` opens the existing host system menu for that app's own foreground window. It requires a ready, visible window, an awake unlocked display, and a gesture from the last five seconds; the host consumes that gesture before opening. Protected app state, active review/refinement, and host overlays block the request. Window close and other system actions remain user choices in the host menu. The request accepts no target window or direct action; its boolean result reports transport submission, not menu acceptance.

An APK with its own window menu calls `setWindowMenuAvailable(true)` after `open` and updates availability as needed. A host advertising `windowMenus:true` reports an actual app-menu gesture through `onHostEvent("app-menu", {})`; draw the menu in the APK window. Apps without this declaration retain the host system-menu fallback. This declaration does not grant the global `ui.app-menu` role.

`notification-content` is an independent, default-denied own-inbox grant. It does not select global notification presentation. While the owning window is visible, unlocked and awake, `requestOwnNotifications()` supplies `own-notification-snapshot-fragment` messages with the same bounded assembly rules and an explicit `generation`. Own snapshots expose no reply actions. `invokeOwnNotification("open"|"dismiss",key,postTime,callId)` consumes a fresh own-window gesture and resolves only this component's current opaque leases. `dismissOwnNotificationGroup(items,callId)` accepts 1–50 `{key,postTime}` entries; the host validates every lease and rejects duplicates before any side effect. Global providers use `notification-dismiss-group` with the same `items`. Results include per-item `outcomes`; partial or uncertain dismissal must not be retried automatically. Hide, lock, grant loss and generation changes clear own leases. Notification snapshots and authorized per-app host-state include `notificationApps` containing only package/name pairs, bounded to 512 entries and 20,000 serialized characters. No additional Android package permission is needed in the consuming APK.

`requestHostRefinement(requestId,original,followup)` is an explicit own-editor fallback using the host's private Anthropic credential. It bypasses the selected global refinement provider. Both strings are limited to 8000 characters. The host requires the dictation grant, an active visible own window, and either a fresh own-window gesture or the exact final transcript from a completed capture within 30 seconds. Authorization is consumed once. Results are `host-refinement-result` `{requestId,text}` or `host-refinement-rejected` `{requestId,reason}`; these are draft content, never Send approval. `cancelHostRefinement(requestId)` cancels only the matching owned request. Hide, lock, grant loss, disconnect and the 120-second deadline cancel outstanding work; backend error details and credentials never cross IPC.

`requestOpenWindow([target])` asks to focus the requesting approved app's own window with its own bounded target. It cannot address another app, wake/unlock the display, interrupt a modal/review/protected window, or authorize microphone capture. Native requests are limited to one per two seconds and existing gesture authority is cleared.

A selected `ui.launcher` provider receives folder-tool requests `{requestId,operation:"folder-tool",name,arguments}` for `apps.list_folders`, `apps.move_to_folder`, `apps.remove_from_folder` and `apps.disband_folder`. Handle these using that APK's local folder state and return `{ok,content?,error?}` through `respondExtension`. Host validation limits app IDs to its current catalog and folder names to the existing host limit. An unavailable or uncertain selected-provider outcome does not mutate fallback host folders. `uninstall-app` is available only to the winning launcher after a fresh gesture and only when the current host catalog marks that entry `uninstallable:true`; it routes through the existing EvenHub uninstall operation.

Mirror pointer input is a host-generated `input` event with `{type:"pointer-click",x,y}`. The host consumes the visible provider surface hit test, bounds integer coordinates to the exact current native viewport, and requires that surface to remain selected, visible and awake before granting fresh UI action authority. A hidden fallback launcher never receives a visible provider's pointer click.
