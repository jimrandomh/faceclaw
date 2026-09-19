# iOS protocol synchronization — 2026-09-17

Merged `main` at `1727474` into `ios-port`. The iOS session now uses the
same transport contract as Android's `CfwTransport`, `CfwMessageWindow`,
`OutboundMessage`, and `BleImageOptimizer`.

- The EvenHub page contains only the input text container. Display commands
  and cleanup use SID `0xf0`, without image-container or image-update headers.
- Mode 6 full frames and mode 3 bounding boxes contain uncompressed RLE.
  Persistent zlib with SYNC_FLUSH runs in wire order at the transport layer.
  Record lengths and checksums describe the same data as Android; packet
  sizes respect CoreBluetooth's maximum write value length (ATT MTU minus 3).
- Commands larger than the uint16 record limit become independent 64-row
  mode 3 bands. Frame metrics advance only when all bands complete.
- The three-command window requires ACKs for both processing lenses on the
  ingress BLE link, with matching stream ID, ordinal, decoded size, and CRC.
  Primary and redundant ACKs are validated before application; completion
  remains ordered even when replies arrive out of order.
- NACKs or 500 ms ACK timeouts replay the entire unresolved window, using
  fresh stream IDs and reset compression contexts. Three retries are allowed
  before reconnecting and invalidating the delta base. Deadlines begin after
  writes finish. Old queued attempts and late ACKs cannot complete replays.
- Firmware acceptance uses shared numeric revision checks (currently
  Faceclaw/13 or newer), replacing the old EVENCFW feature-token check.
  Legacy or stock firmware is rejected before display startup.

Merge conflicts retained iOS voice restrictions while preserving main's
asynchronous transcription finalization. The iOS voice-state bridge supplies
the new listening/detail fields. Test harnesses account for platform globals
and the shared SVG rasterizer.

Validation: TypeScript checking and signed physical-device iOS build pass.
The simulator build launches and renders the main screen and shared launcher.
The final signed app is installed on the development iPhone. The user renewed
developer-certificate trust after iOS initially blocked launch. A subsequent
NativeScript deployment launched successfully, connected to the glasses, and
received both-lens ACKs for a display frame.
The transport parity test compiles Android's production Java encoder and
compares complete packets, including persistent history, reset, MTU limits,
and raw fallback for incompressible maximum-size records. Session tests cover
ACK identity, two-lens completion, ordered pipelining, band reconstruction,
NACK replay, timeout/retry limits, microphone/input responsiveness, and cleanup.

The full suite has 420 passing tests and 21 failures. All 21 reproduce on a
clean archive of main at 1727474: compass, pinball/touch, and terminal test
harness/behavior checks. There are no additional failing tests from this merge.

Further hardware acceptance: scroll and animate the display, visually check
both lenses, exercise mic and ring input, lock the phone, and disconnect/reconnect.
The initial successful frame does not establish sustained radio reliability.

## Development deployment and stale LiveSync code

Installing the IPA with `devicectl` alone left an old September 8 JavaScript
bundle in `Library/Application Support/LiveSync/app` in the app's data container.
NativeScript debug startup used that bundle instead of the newly installed
one, causing the obsolete `img640, fbguard, wearnotify` firmware rejection.
Refreshing through NativeScript fixed the issue without clearing app settings:

```sh
npm run run:ios -- --device 00008150-000C383921A3C01C --no-hmr --no-watch
```

Use this deployment path when updating an existing development installation.
The refreshed on-device `bundle.mjs` was copied back and verified against the
prepared bundle; it contains the shared revision-13 check and SID `0xf0`.
