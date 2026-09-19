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

The shared Kotlin suite runs separately from the Node tests:

    npm run test:kotlin
    npm run test:kotlin:ios

It includes the migrated compass, R1 battery, gesture and texture Java fixtures,
which now call the Kotlin implementation from Android host tests. Common tests
also run as native iOS simulator binaries. See [the Kotlin README](../native/kotlin/README.md)
for SDK requirements, source layout and coverage. The compass and battery
fixtures retain the golden packets shared with firmware tests.
