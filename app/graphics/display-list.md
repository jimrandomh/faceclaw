# TypeScript display lists

`GrayImage.drawDisplayList(list, x, y, width, height, depth)` retains a list alongside
the image's ordinary pixels. Existing frame submission (`prepareFrameDraws`) and
shell scene submission carry it to Kotlin. Bounds describe its footprint for plane
occlusion; draw coordinates are relative to its placement. Keep the list, its image
resources, and their pixel buffers immutable after submission.

```ts
import { DrawExpression as E } from './draw-expression';
import { DrawOp, type DisplayList } from './display-list';

const list: DisplayList = {
  resources: [],
  timeline: { token: animationId, startedAt: Date.now() },
  calls: [{
    op: DrawOp.ROUNDED_RECT,
    x: E.progress(300).ease().lerp(E.f32(0), E.f32(100)).toInt(),
    y: 0,
    width: 40, height: 20, radius: 6,
    background: 4, border: 15,
  }],
};
frame.drawDisplayList(list, 20, 30, 140, 20, 0);
```

Supported calls in this first pass:

- `ROUNDED_RECT`: literal or expression `x`/`y`, literal dimensions/radius, and
  4-bit colors (0–15). Border 16 means no border. Fill takes the maximum of the
  background color and existing pixels.
- `IMAGE`: a local resource index, integer `x`/`y`, and `transparent`. Transparent
  images skip pixels quantized to zero. Resources have `width`, `height`, and
  gray8 `pixels`; a baked `GrayImage` can be used directly.
- `RECT_COPY`: a local resource index, source rectangle and destination
  `dx`/`dy`. Source x/y and `dx`/`dy` accept expressions (revision 29); the
  source rectangle must stay inside the source at every time, or firmware
  rejects the list. `SCREEN` reads the uncomposed frame; its source coordinates
  are also relative to this list's placement. Each call may add its own `depth`
  to the list's depth. A screen restore normally uses the negative of the list depth.

Kotlin allocates/cache-pins all image resources, resolves the local indices, applies
surface placement, and includes the calls in the root firmware display list. The
phone's existing display-list renderer consumes the same compiled calls. This uses
the current firmware protocol; no firmware update is needed for this bridge change.

## Expressions and time

`E.i32` and `E.f32` construct typed constants. Builders support arithmetic, min/max,
integer remainder, negation, explicit conversions, lerp, and the easing functions
in `ExprOp`. `ease()` defaults to smoothstep. Integers wrap at 32 bits; float
operations round to f32. The firmware's existing stack/error semantics apply.
Rounded-rectangle x/y and rect-copy source/destination coordinates accept
expressions. `E.progress(duration, delay)` stays 0 for the first `delay` ms of
the timeline, so one list can run motions that started at different times.

`maximum.time()` returns `min(milliseconds since PRESENT, maximum)`. The existing
45 ms repaint timer remains active while this is below maximum. `E.elapsed()` is
a bridge binding: Kotlin replaces it with the timeline's elapsed milliseconds when
building a new root list. It is a constant within that PRESENT, not a second clock.
`E.progress(durationMs)` combines the two and clamps to 0..1 so intervening frames
and PRESENTs continue an animation instead of restarting it.

Keep `timeline.token` and `timeline.startedAt` stable for an animation; use a new
token when restarting it. JS sends an elapsed duration, so JS and native clocks
need not share an epoch. Fingerprints include the token and expression code but
exclude the changing elapsed duration. Without a timeline, raw `time()` expressions
start at each PRESENT. Native compilation strips the bridge-only elapsed opcode.

`menu-selection-list.ts` authors both the rounded highlight and the transparent row
image using this API. `menu-scroll-list.ts` authors a menu scroll: a viewport-sized
copy from a strip resource whose source y animates, then the highlight. Navigation eligibility, duration, and easing remain in
TypeScript. There is no animated-menu tag or menu animation policy in Kotlin.

## Bridge framing

Tag 7 is followed by a little-endian u32 byte length and a bounded body:
placement (i16 x/y, u16 width/height, i8 depth), timeline (u32 token/elapsed),
u16 resource count, gray8 images (u16 width/height followed by pixels), u16 call
count, then calls. Calls start with the firmware opcode and an i16 relative depth;
operands otherwise use their fixed-width fields, except rounded x/y and rect-copy
x/y/dx/dy which use extended varints. Expressions use the firmware bytecode plus bridge-only
`ELAPSED = 128`. Resource indices are local to this record, never firmware IDs.
Rect-copy source x/y are signed here to permit relative SCREEN coordinates.

Limits: 256 images per record, 64 KiB per packed image, 4 MiB per bridge record,
4096 calls, and 900 input bytes per expression. Native validates the bound program
against the firmware's 1024-byte limit. The combined scene must also fit the
existing resource cache, root-list size, and VM stack limits.
