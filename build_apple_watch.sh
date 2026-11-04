#!/bin/bash
# Builds the Apple Watch app (apple-watch/).
#
#   ./build_apple_watch.sh             Simulator build; no signing needed.
#   ./build_apple_watch.sh --device    Signed build for a real watch.
#   ./build_apple_watch.sh --install   As --device, then installs on the paired watch.
#
# Signing uses IOS_TEAM_ID from build_paths.sh. The bundle ID follows IOS_BUNDLE_ID,
# because the watch app is tied to the phone app by it. To pick among several
# watches, set APPLE_WATCH_DEVICE_ID to its UDID there (see `xcrun devicectl list devices`).
#
# This is for working on the watch app alone. It can only talk to a phone app that
# was built with FACECLAW_EMBED_WATCH=1 (see apple-watch/README.md).
cd "$(dirname "$0")"; source scripts/before_build.sh
set -euo pipefail

mode="${1:-simulator}"
project=apple-watch/Faceclaw.xcodeproj
derived=apple-watch/build

node scripts/apple-watch-embed.cjs config

case "$mode" in
  simulator|--simulator)
    xcodebuild -quiet -project "$project" -scheme Faceclaw -configuration Debug \
      -destination 'generic/platform=watchOS Simulator' -derivedDataPath "$derived" \
      CODE_SIGNING_ALLOWED=NO build
    echo "Built $derived/Build/Products/Debug-watchsimulator/Faceclaw.app"
    ;;
  --device|--install)
    if [[ -z "${IOS_TEAM_ID:-}" ]]; then
      echo "Set IOS_TEAM_ID in build_paths.sh to sign for a real watch." >&2
      exit 1
    fi
    destination='generic/platform=watchOS'
    if [[ "$mode" == --install ]]; then
      watch="${APPLE_WATCH_DEVICE_ID:-$(scripts/apple-watch-device.sh)}"
      if [[ -z "$watch" ]]; then
        echo "No Apple Watch found. Enable Developer Mode on it, with its iPhone connected to this Mac." >&2
        exit 1
      fi
      # Naming the watch is what gets it registered with the team and into the
      # profile; a generic destination signs for whatever is registered already.
      destination="platform=watchOS,id=$watch"
    fi
    # A watch's Wi-Fi link can take minutes to wake, far past xcodebuild's default wait.
    xcodebuild -quiet -project "$project" -scheme Faceclaw -configuration Debug \
      -destination "$destination" -destination-timeout 300 -derivedDataPath "$derived" \
      -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
    product="$derived/Build/Products/Debug-watchos/Faceclaw.app"
    echo "Built $product"
    if [[ "$mode" == --install ]]; then
      xcrun devicectl device install app --device "$watch" "$product"
    fi
    ;;
  *)
    echo "Usage: $0 [--device|--install]" >&2
    exit 2
    ;;
esac
