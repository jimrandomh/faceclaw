# Window motion v1

Use this optional design contract for app cards, notification dropdowns and expanded readers. The host does not enforce it. Java and JavaScript helpers implement the same geometry and share golden test fixtures.

- Duration: 360 ms. Request a frame every 40 ms (25 fps target). Actual delivery depends on rendering, IPC, BLE and the display.
- Width leads height: cubic ease-out, horizontal progress `p / .78`, vertical progress `(p - .1) / .9`, each clamped to 0–1. Heading follows the card; body text remains at its final coordinates and is clipped by the moving card.
- Opening draws the frame and heading immediately. At 90% (324 ms), build and reveal the body. Avoid sorting, wrapping or rasterizing body content before that point.
- Before closing or reversing toward closed, release the outgoing body raster. Draw only the frame and heading over the destination. Preserve application data, selection and scroll position separately.
- Back reverses immediately from the last drawn rectangle. Restart the 360 ms transition toward the new destination. Do not jump to an endpoint first.
- Use elapsed time, skip obsolete frames after stalls, and always submit the final state. Keep one scheduled render request; the SDK transport already keeps one in-flight and one newest pending bitmap.
- Cancel callbacks and release visual caches on hide, sleep, removal, disconnect, resize or invalidated source content. Resume by drawing current state at the current viewport. Background data work is independent of visual animation.

## Java

Use `WindowAnimator` on the main looper for timed callbacks and `Ui.transitionCard` for the frame, heading, body clipping and reveal gate. Its body callback runs only when `bodyVisible` is true. Cache expensive body rendering there. `WindowMotion` is the timer-free model for apps with an existing render loop. `FrameAnimator` remains available for other effects.

[AnimatedCardAppService.java](examples/AnimatedCardAppService.java) is a complete service example, compiled with the SDK fixture. All normal app approval and capability checks still apply.

## JavaScript and TypeScript

Install the local `android-sdk/javascript` package (`@faceclaw/motion`) or consume it through your build's workspace dependency. `WindowAnimator` drives callbacks; `WindowMotion` supports an existing render loop; `FrameRequest` coalesces render requests. NativeScript callers with an existing loop should supply Android's monotonic uptime when sampling. Browser defaults use `performance.now()`.

[animated-card.cjs](examples/animated-card.cjs) shows renderer integration. The application owns pixels, content caches and lifecycle hooks. Gate body creation on `frame.bodyVisible` and release it before calling `retarget(..., true)`.

Run `node --test javascript/test.cjs` and `./gradlew :sdk:testDebugUnitTest :sdk:lintDebug :fixture:assembleDebug` from this directory. Geometry tests use `sdk/src/test/resources/window-motion-v1.csv`, including a stalled final frame and immediate reversal. These checks do not measure physical glasses frame rate.
