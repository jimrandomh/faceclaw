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
