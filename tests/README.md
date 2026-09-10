# Tests

Faceclaw's pairing logic (`app/g2/glasses-hardware-identity.ts`,
`ble-proximity.ts`, `even-advertisement.ts`, `pairing-candidates.ts`,
`glasses-artwork.ts`) is written without NativeScript imports so it can run
under plain node. The tests here cover hardware-identity decoding, proximity
estimation, the advertisement parsers, and left↔right pair grouping.

Run with:

    npm test

That compiles the pure modules with the project's TypeScript into
`.test-build/` (git-ignored) and runs `node --test tests/`. No extra
dependencies are needed — the tests are plain `.test.cjs` files that use
`node:test` and `node:assert`.

Compass diagnostics have focused UI and wire-format checks:

    node --test tests/compass-debug.test.cjs tests/compass-protocol.test.cjs

The protocol check also compiles the production Java parser, so it needs a
JDK (`JAVA_HOME`, or `javac` and `java` on `PATH`). Its golden packet is shared
with the firmware encoder test in `g2flash/tests/compass_diagnostics_test.c`.

R1 battery field-106 decoding (valid zero, charging, unavailable/disconnected,
legacy firmware, malformed messages) uses the same C/Java golden packet:

    node --test tests/ring-battery-protocol.test.cjs
