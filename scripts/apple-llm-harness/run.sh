#!/bin/bash
# Run one assistant request against Apple's on-device model on this Mac (macOS 26.4+,
# Apple Intelligence on), through the same Swift bridge the iOS app uses, with the
# assistant's real tool list. Prints tool routing, tool calls and the streamed reply.
#   scripts/apple-llm-harness/run.sh "set a timer for five minutes" ["previous prompt"]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${TMPDIR:-/tmp}/faceclaw-apple-llm-harness"
mkdir -p "$out"
node "$here/extract-tools.cjs" > "$out/tools.json"
swiftc -swift-version 5 -parse-as-library -target "$(uname -m)-apple-macos26.4" \
  "$here/../../App_Resources/iOS/src/FaceclawSystemLanguageModel.swift" "$here/main.swift" -o "$out/harness"
"$out/harness" "$out/tools.json" "$@"
