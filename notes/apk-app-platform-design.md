# Independently installed Faceclaw applications

Status: implemented across the generic host/SDK, T3 host, Signal APK and bridge. Automated/emulator validation is recorded below; physical-device and real-account acceptance remain. The user confirmed the complete scope and shared understanding on September 7, 2026.

## Agreed direction

- Applications are independently installed Android APKs with their own code, data, and Android permissions.
- Support independent developers with their own signing identities.
- Implement the host integration against upstream Faceclaw and keep it portable into the T3 fork.
- Signal is the first application. Its Android source lives in the sibling `faceclaw-signal` repository.
- Signal CLI functionality belongs in the T3 code bridge. The existing Faceclaw bridge development checkout is `faceclaw-t3-bridge`; it contains uncommitted integration work that must be preserved.
- Applications control pixels within their assigned viewport. Faceclaw owns composition, Bluetooth delivery, system menus, app switching, display sleep, and reserved gestures.
- Support ordinary Android drawing and optional Faceclaw drawing/UI helpers, including a combination within one screen.
- Initially both drawing styles produce pixel frames. Keep the public API compatible with a future cached-drawing transport; add that optimization only when measurements justify it.
- The initial Signal scope includes text conversations, groups, recipient selection, incoming alerts, and dictated replies reviewed before sending. Attachments and voice messages are later work; calls are outside the initial scope.
- Signal is glasses-only; do not build a phone messaging interface. Account linking, retention, and assistant access are managed in the bridge dashboard. APK approval and host connection are managed in Faceclaw settings. Signal uses separately scoped bridge credentials.
- A reachable running bridge is required for live messaging. Signal receives messages and provides alerts through the existing Faceclaw notification system while other apps are open or the display is asleep.
- Signal reply handling is restricted to Signal conversations; it must not intercept or send replies for unrelated apps.
- Retain bridge history for a configurable 30 days by default, with protected storage and support for Signal disappearing-message and deletion behavior. Initial history covers messages observed after linking; historical import is not promised.
- Assistant access is separately enabled for user-selected conversations, with read/draft access and confirmation before sending.
- Initial distribution uses normal Android APK installation, update, and removal. Faceclaw discovers compatible installed apps and adds approved apps to its launcher; no initial catalog/update service.
- While disconnected, preserve drafts and require explicit sending after reconnection. Reconcile uncertain send outcomes before offering a retry to prevent duplicate messages.
- The same Signal APK supports upstream Faceclaw and the T3 fork through a compatible host contract. Users select one active host, remembered until explicitly switched.
- The initial developer SDK is a Kotlin/Java Android library with Kotlin examples. Both ordinary Canvas drawing and optional Faceclaw helpers are supported. Keep the connection protocol independent of language; a TypeScript wrapper is later work.
- The Signal APK feeds bridge events into the existing Faceclaw popup/inbox through a permission-controlled SDK notification API. Opening an alert routes to the exact Signal conversation.
- An explicit setup setting suppresses forwarding of official Signal notifications to the glasses while the integration is enabled. It does not change official Signal phone notifications. Disabling the integration restores the previous forwarding preference.
- Reuse host dictation/review. Explicit Send routes through the Signal APK and bridge to signal-cli. Never fall back to the official Signal app's notification reply action.

## Inspected facts

- The current worker/window messages provide useful lifecycle, input, and viewport boundaries. NativeScript workers have direct native access and are not an external-app security boundary.
- The native compositor accepts pixel-only frames. The host retains pixel comparison and incremental display updates without app-supplied glyph metadata.
- Cached glyph/image identities optimize delivery; they do not increase visual expressiveness. External processes cannot reuse host static atlas identifiers directly.
- Existing Faceclaw drawing code already uses Android Canvas/Bitmap for fonts and icons. Optional public helpers still require extraction from internal dependencies.
- Initial emulator measurements now cover independent-APK rendering and transport. Synthetic Signal rendering at 576×260 measured 2.017 ms median / 4.590 ms p95; upstream SDK submission through the native private-copy callback measured 6.393 ms median / 7.464 ms p95. These separate measurements exclude final composition, Bluetooth, and optical text comparison. Physical-device performance and text parity remain acceptance work.
- The bridge has a service registry, but current handlers lack caller-specific authorization context. Signal needs separately scoped access and explicit process/event lifecycle management.
- Do not promise import of existing Signal phone history: contact/group sync is documented, while a historical-message import contract has not been established.
- Upstream ingests Android notifications, but the T3 fork's structured MessagingStyle and RemoteInput features are additions. Current T3 notification routing uses a global callback into the T3 window; routing to independent APK conversations is new host functionality.
- Notification grouping is scoped to Android package/profile/conversation. Official Signal notifications and a separate APK's notifications are not automatically deduplicated.
- Generic host dictation and review exist upstream. Exposing that flow across APK IPC is new work.

## Proposed technical contract

These details make the approved product behavior concrete. Verification records distinguish implemented behavior from remaining validation.

### Host and SDK

- Keep the Android SDK/library, protocol definitions, Kotlin examples, and integration documentation with the upstream host change. The Signal repository consumes a versioned library; local development may use a composite build. A public artifact publication is later release work.
- Discover APK services using an explicit Faceclaw service contract and manifest metadata. Negotiate protocol version, capabilities, and viewport at connection time. Reject incompatible major versions with a useful settings message; negotiate optional features independently.
- Use bound-service IPC for control and a bounded frame transport hidden behind the SDK. Evaluate shared-memory frame buffers to avoid large per-frame control transactions. Copy and validate untrusted frame data before native composition; do not assume a shared buffer stays unchanged while being read.
- Bind approval to Android user, package, and verified signing identity. Authenticate both sides of a connection. An app can operate only its own sessions, windows, frames, notifications, and approved capabilities. Neither party accepts a caller-supplied package name as proof of identity.
- Treat host selection as exclusive. Switching the active host tears down that host's IPC sessions/capability grants, cached notifications, and reply authority; an unselected host cannot receive app frames or message content. The APK's bridge credential and independently controlled assistant grants are separate revocation domains.
- The SDK exposes viewport/lifecycle/input events, frame submission, app-scoped notifications, and user-initiated dictation/review. Grant sensitive capabilities separately and support revocation. It does not expose arbitrary host Java objects, BLE access, other apps' notifications, or the full T3 credential.
- The SDK supports ordered pixel layers and explicit compositing rules. Canvas conversion handles grayscale and Faceclaw transparency conventions. Optional helpers cover text measurement/wrapping, lists, basic cards, and animation scheduling needed by Signal; arbitrary custom drawing remains available.
- Frame sessions use negotiated dimensions, ownership, sequence/generation IDs, bounded memory, and latest-frame coalescing. Resize, host switch, disconnect, and revocation invalidate stale frames and callbacks. Rendering pauses for hidden/asleep windows; background events continue through the notification channel.
- Host-owned shell behavior remains in each host adapter. Upstream and T3 may retain different navigation and notification presentation policies without changing the APK.

### Signal runtime and notifications

- Start with one linked Signal account per bridge instance. Keep account identity explicit in credentials, stored records, and send requests so account confusion is prevented and future expansion is possible.
- Add Signal as an optional supervised service inside the existing bridge. It must start and operate without a live T3 agent provider. Own signal-cli startup, readiness, receive subscription, bounded restart/backoff, and shutdown explicitly.
- Prefer signal-cli's stdin/stdout JSON-RPC interface under bridge supervision. Verify supported runtime/version requirements during setup and expose actionable health status. Do not register a replacement primary Signal account.
- Link the account through the bridge dashboard using the official Signal linked-device flow. Dashboard setup provisions a separately scoped APK credential through an authenticated, short-lived exchange. Do not expose reusable credentials in URLs, logs, or QR payloads intended for public sharing.
- The APK owns its Signal bridge connection independently of its visible window. While the integration is enabled, the selected Faceclaw host maintains the approved background service connection. Handle Android process death and reconnect; do not promise delivery while Android or network connectivity prevents the app from running.
- The bridge continues receiving when the phone is absent. Use resumable events and snapshot reconciliation on reconnect. Retained history synchronizes without replaying old backlog as a stream of fresh wake-up alerts.
- Bridge-observed events are authoritative for this integration. Notifications use app-scoped opaque conversation targets. Deleted/expired messages disappear from host alerts and local caches; stale targets cannot reopen removed content.
- Apply the selected host's notification display and source-filtering policies to SDK notifications. Proposed initial Signal preview default is sender plus message text, matching the requested existing notification experience, with a sender-only option in setup. This is independent of official Signal phone preview settings. Phone/emulator mirrors use the existing host preview controls; diagnostic tests use synthetic content, and ordinary logs do not record message bodies or credentials.
- Suppression of official Signal forwarding is scoped to glasses presentation and the selected Android profile. Preserve the user's underlying forwarding choice so disabling the integration restores it. Do not cancel official phone notifications or automatically switch sending transports during outages.
- Host dictation returns a review-bound result associated with the initiating app/account/conversation. Explicit Send dispatches through the APK. Cancellation, target change, revocation, or account change invalidates the pending send authority.

### Data and assistant behavior

- Store message history and necessary local drafts with protected storage. Apply the configured retention window, default 30 days, and any earlier Signal expiry/removal requirement across integration-owned bridge history, APK caches/drafts, host notification caches, and content-bearing signal-cli artifacts. Audit backup/log paths and exclude message content from ordinary diagnostics/backups by default. Keep required Signal account keys separate from message TTL cleanup. Account unlink/reset clears associated integration credentials and message caches with an explicit destructive-action confirmation in setup.
- Model disappearing messages using protocol expiry/read events; do not extend their lifetime to the retention default. Enforce known expiry while offline and reconcile deletions without resurrecting stale content on reconnect. Popup display alone must not generate a read acknowledgement. Verify the precise signal-cli timer contract before implementation; if correct expiry cannot be supported, surface that limitation for a design decision instead of silently retaining messages.
- Persist send intent/status before dispatch, with caller-generated operation identity and duplicate-request protection. A timeout after dispatch is an unknown outcome, not permission to replay. Reconcile using available signal-cli results/sync events; if no definitive evidence exists, retain an explicit unknown state without automatic retry. Do not claim exactly-once delivery from an upstream API that does not guarantee it.
- Restrict assistant grants to selected conversations and read/draft capabilities. Each send confirmation authorizes the exact account, recipient/conversation, and text, expires, and cannot be reused. A model-generated statement is not evidence of user approval. Recheck authorization immediately before dispatch. Assistant revocation applies immediately to assistant reads, subscriptions, drafts, and pending sends without disconnecting the Signal APK. Enabling assistant access must explain that content copied into an assistant conversation follows that system's retention; access revocation cannot retract already delivered text.
- No phone messaging UI, attachment sending, voice messages, calls, arbitrary historical import, app marketplace, TypeScript wrapper, or cached draw protocol in the first release.

## Delivery and verification

1. Implement the generic host protocol and Android SDK in `faceclaw-app-platform`, with focused fixtures for discovery, approvals, lifecycle, pixel submission, and rejection of invalid callers/frames. Signal is the product app; fixtures are testing support.
2. Add the optional Signal service and scoped app/assistant access in `faceclaw-t3-bridge`, preserving existing uncommitted work. Implement protected storage, expiry, deletion, event resumption, and uncertain-send handling with focused failure tests.
3. Build `faceclaw-signal`: glasses conversations, groups/recipients, history, composition, shared dictation/review, background alerts, and setup integration. Exercise mixed Canvas/helper rendering in real Signal screens.
4. Integrate the portable host changes into the T3 fork without replacing its shell policies or unrelated edits. The same Signal APK must function against both hosts.
5. Compare Signal text clarity, scrolling, and transitions with a comparable built-in screen on emulator, phone preview, and glasses. Measure frame delivery, dropped/coalesced frames, memory and CPU behavior, and input responsiveness. Set numerical performance budgets from the measured baseline before calling the implementation release-ready; no frame-rate guarantee has been established.
6. Verify app death/restart, bridge outage, host switching, revoked grants, stale replies, unknown send results, expired/deleted content, no duplicate glasses alerts, and isolation from unrelated app notifications. Verify installation/update/removal without rebuilding the host, and compatibility rejection without disrupting other apps.
7. Run each repository's required checks. Prepare the generic host/SDK change for independent upstream review and keep Signal/T3-specific code outside that core. Publishing APKs/SDK artifacts and opening a release PR are later explicitly selected delivery actions.

Security-sensitive and database implementation follow the required specialist ownership routes. The shared-understanding checkpoint is confirmed.

All three Android debug builds succeed. Signal's 16 unit tests and real Android storage/rendering/animation instrumentation pass. T3's 532 tests pass. Upstream passes 256 of 259 tests; the same three touch-input/pinball failures reproduce on the clean baseline. The bridge's required checks pass 332 frontend, 40 deployment and 190 bridge tests, including 19 Signal tests. The installed host native managers are exercised through separate-UID Android instrumentation, including approval/identity, frame bounds, lifecycle, capabilities and restored-backup consent. The bridge dashboard was exercised with synthetic data, and pinned signal-cli 0.14.7 was smoke-tested without an account.

The generic developer entry point is [the Android SDK](../android-sdk/README.md). Signal's build/setup instructions live in the sibling `faceclaw-signal/README.md`; bridge setup, MCP connection, expiry/deletion limits and recovery are documented in `faceclaw-t3-bridge/docs/signal.md`. Signal timers use conservative earlier expiry because the pinned JSON interface omits the original read-start; full cross-device deletion/edit parity is not claimed. No real Signal account has been linked, no real messages have been sent, and no release or pull request has been published.

The subsequent T3 notification-override patch extends the generic SDK with negotiated, single-use notification reply actions and bounded result acknowledgements. The T3 fork applies its own custom presentation and routing to APK notifications; Signal has no T3-specific logic. Both stock and replacement readers can return exact reviewed text to the originating app. Updated checks pass T3 549/549, Signal 21/21, SDK 5/5, and eight Android boundary tests on each installed host; upstream passes 263/266 with the same three baseline failures.
