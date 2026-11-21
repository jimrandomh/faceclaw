#!/usr/bin/env bash
# Regenerate tests/fixtures/screen-recording/ from the Kotlin tests that produce them
# (ScreenRecorderTest and GlassesSessionCoreTest leave them in tests/kotlin/build).
# tests/screen-recording.test.cjs replays them with the visualizer's JavaScript.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/test-kotlin.sh cleanTestAndroidHostTest testAndroidHostTest --no-watch-fs \
  --tests '*ScreenRecorderTest*' --tests '*GlassesSessionCoreTest*'
mkdir -p tests/fixtures/screen-recording
for name in opcodes.fcrec.jsonl opcodes.expected.json session.fcrec.jsonl; do
  cp "tests/kotlin/build/screen-recording-$name" "tests/fixtures/screen-recording/$name"
done
ls -l tests/fixtures/screen-recording
