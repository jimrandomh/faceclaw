# Screen recording format (version 1)

A screen recording is what the phone app writes when you choose *Record screen* and then
*Stop recording*: the glasses' display state at the moment recording started, followed by a log
of every Bluetooth message written to the glasses, the frame-timing annotations
(`FrameTimingsCore`, the same events `frame-timings.txt` is built from) and the session's log
lines. The writer is `ScreenRecorder` in
`native/kotlin/shared/src/commonMain/kotlin/com/faceclaw/app/util/ScreenRecorder.kt`; the reader
is `recording.js` here.

The file is named `recording-<yyyyMMdd-HHmmss-SSS>.fcrec.jsonl` and is
[JSON Lines](https://jsonlines.org/): one JSON object per line, UTF-8. The first line is the
header. Every record has:

- `type`: which kind of record it is (below);
- `t`: when, in integer milliseconds on the phone's monotonic clock
  (`elapsedRealtime`, which counts from boot and includes sleep).

Records are written in the order their events were recorded, which is nearly but not exactly
time order (several threads record). Binary fields are standard base64. A field whose value
would be null or false is left out. Readers must ignore record types and fields they don't
know; a change that old readers would misread bumps `version`.

A recording is held in memory until it is saved, so it has a size backstop (96 MB of
payloads): past it, a `mark` record says so, later events are dropped, and `end.truncated` is
true.

The draw protocol the messages speak is implemented by `DrawProtocol.kt` (encoding) and
`DisplayListRenderer.kt` (the reference interpreter) under `native/kotlin/shared/`, and by
`emulator.js` here; `notes/display-list-protocol.md`, where present, describes it in prose.

## Header

```json
{"type":"header","t":1430467984,"format":"faceclaw-screen-recording","version":1,
 "wallClockMs":1795234867855,"localTime":"2026-11-20 20:21:07.855","glasses":"g2","width":640,"height":480}
```

- `wallClockMs`, `localTime`: the wall clock at `t` (Unix ms, and formatted in the phone's zone).
  Add `wallClockMs - t` to any other `t` for its wall-clock time.
- `glasses`: `g2`, `rayneo-io`, `g1`, or `none` (preview-only mode: no glasses, so no messages).
- `width`, `height`: the screen in pixels, or 0 if nothing had been configured yet.

The recording's zero is the header's `t`. Records can carry earlier times: frames that were
already open when the recording started are replayed into it with their own times.

## Starting state

```json
{"type":"state","t":…,"lenses":3,"width":640,"height":480,"root":17,
 "screen":"<base64>","resources":[{"id":0,"owner":"shell:1:640x32","data":"<base64>"}, …]}
```

What a lens holds once every message *planned* before the recording has run. That includes
messages still queued or unacknowledged at that moment, which is why those are marked
`baseline` when they are written (see below): the state already counts them.

- `lenses`: bit 1 = left, bit 2 = right. A G2 or RayNeo iO has one record for both (`3`); a G1,
  whose arms are separate devices with separate frames, has one per lens.
- `screen`: the screen buffer, packed 4 bits per pixel, rows of `ceil(width/2)` bytes, high
  nibble first. Absent when unknown (treat as black).
- `root`: the root display list's resource ID, or 65535 for none (the screen buffer is presented
  as it is).
- `resources`: the resource cache, each entry the resource's bytes in the wire format (a flags
  byte whose low two bits are the type: 0 image, 1 font, 2 display list). `owner` is present on a
  writable surface, and its `data` holds the surface's current pixels.

There is no state record when the planner tracks none: before a session is ready, or right
after it reset its model of the glasses. The messages that follow then rebuild everything (they
start by evicting every resource and repainting the whole screen).

## Messages

```json
{"type":"msg","t":…,"id":412,"attempt":1,"kind":"resources","label":"resource command 1265B",
 "sid":240,"magic":125,"arm":"L","lenses":3,"frame":3,"update":7,"part":1,"parts":1,
 "wire":[151],"payload":"<base64>"}
{"type":"sent","t":…,"id":412,"attempt":1,"ok":true}
{"type":"lens-ack","t":…,"id":412,"lens":1}
{"type":"lens-ack","t":…,"id":412,"lens":2}
{"type":"ack","t":…,"id":412}
```

- `msg`: the message is about to be written. `id` names it for the rest of the recording.
  - `payload`: the logical message, before the link's stream compression. For `sid` 240 (0xf0,
    the private stream) that is one message of the draw protocol: its first byte's low 7 bits are
    the type (21 upload, 22 evict, 26 draw calls, 27 set root, 28 present, 29 create surface, 30
    brightness, …; see `CfwMessageType.kt`). For other sids it is the stock protocol's protobuf.
  - `wire`: the size in bytes of each Bluetooth packet actually written, headers and CRC
    included. The stream is compressed as a whole (one persistent deflate context per arm), so
    this is exact for the message but can't be divided among its parts.
  - `arm`: which arm it was written to (`L`/`R`). `lenses`: which lenses must act on it and
    acknowledge it (private stream only): `3` on a G2, where the left arm forwards to the right;
    `1` or `2` on a G1.
  - `kind`, `label`: the session's own bookkeeping names (`image` is the message that completes a
    screen update; `resources` are the uploads and draws ahead of it; `heartbeat`, `battery`, …).
  - `frame`: the frame-timings frame whose update this message carries. `update`, `part`,
    `parts`: the image update it belongs to and its position in it.
  - `baseline: true`: planned before the recording started. Its effect is already in the `state`
    record, so a replay must not apply it again; its bytes still count as traffic.
  - A replay of a message (after a lost or refused acknowledgement) is a second `msg` with the
    same `id`, a higher `attempt`, its new `magic` and `wire`, and no payload.
- `sent`: that write returned. `ok: false` means the link refused it or timed out.
- `lens-ack`: one lens acknowledged the message (`lens` 1 = left, 2 = right), or with
  `nack: true` refused it. The firmware acknowledges after processing, so this is the best
  available time for "the message took effect on that lens".
- `ack`: the message is complete: every lens it needed has acknowledged it (or, for the stock
  protocol, its reply arrived).
- `timeout`: it ran out its acknowledgement deadline.

```json
{"type":"write","t":…,"arm":"R","label":"iO frame business=240","wire":[24]}
```

- `write`: packets written outside the message queue (link control frames on a RayNeo iO or a
  G1, relayed raw packets, a prewritten message prefix). They are traffic to count; there is no
  payload, acknowledgement or effect on the display to record.

To reconstruct a lens's display: start from its `state`, then apply each private-stream message
that is not `baseline`, once, at that lens's first `lens-ack` for it, in file order.

## Frame timings

```json
{"type":"frame","t":…,"id":3,"parent":2,"reason":"render:shell","wallClockMs":…}
{"type":"frame-note","t":…,"id":3,"text":"fg=terminal:view:1 target=window"}
{"type":"frame-log","t":…,"id":3,"thread":"main","text":"span paint start"}
{"type":"frame-log","t":…,"id":3,"thread":"main","text":"span paint end (12ms)"}
{"type":"frame-end","t":…,"id":3,"outcome":"sent"}
```

The events of `FrameTimingsCore` as they happen (its class comment says what frames and their
trees mean). `frame` starts one; `parent` links it under the frame that caused
it. `frame-note` appends to its label. `frame-log` is a line of its log; spans appear as the
lines `span <name> start` and `span <name> end (<n>ms)`. `frame-end` gives the outcome: `sent`,
`discarded: …` or `timeout: …`. Unlike the text export, nothing is capped or sampled: every
frame and every line is here.

## Session log

```json
{"type":"log","t":…,"level":"I","text":"queue image update#83 fingerprint=… messages=1"}
```

The session's own log lines (the ones under the `FaceclawComm` logcat tag), `level` `I`, `W` or
`E`.

## Phone composites

```json
{"type":"screen","t":…,"source":"phone","width":640,"height":480,"encoding":"deflate","pixels":"<base64>"}
```

The phone's own composite of what it means the screen to show (the picture the phone-side
preview displays), packed 4 bpp as in `state.screen` and then zlib-deflated. A repeat of the
previous composite is not written.

A session on the draw protocol has one at the start and one at the end, as a check on the
replay; taking more would disturb the timings being recorded. Other sessions (preview-only
mode) have one per phone-preview refresh that changed something, at most one a second: for
them these are the only picture there is.

The composite is of the phone's *intent*, so it runs ahead of the glasses while frames are in
flight, and it leaves out the whole-screen stereo shift.

## Stock font

```json
{"type":"stock-font","t":…,"glyphs":[{"cp":65,"x":1,"y":4,"width":9,"height":14,"pixels":"<base64>"}],
 "advances":[[65,66,11],[66,32,6]]}
```

Draw opcode 3 draws text in a font built into the glasses, so a replay needs that font. Before
the messages of each frame, the recorder writes the glyphs its stock-font text uses that the
recording doesn't have yet: `pixels` are 4 bpp rows of `ceil(width/2)` bytes, drawn at the pen
position plus (`x`, `y`). `advances` are triples of code point, the code point after it, and how
far the pen moves between them (the firmware's kerning included), as the phone's own layout
of that text had it.

## Marks and the end

```json
{"type":"mark","t":…,"text":"recording hit its size limit; later records were dropped"}
{"type":"end","t":…,"truncated":false}
```

`end` is the last record of a recording that was stopped normally. A file without one was cut
short.
