#!/bin/bash
# Prints the UDID of the first real Apple Watch devicectl can see, if any. A UDID
# works both as a devicectl --device and as an xcodebuild destination id.
set -euo pipefail
output="$(mktemp)"
trap 'rm -f "$output"' EXIT
xcrun devicectl list devices --quiet --json-output "$output" >/dev/null
node -e '
  const devices = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result.devices;
  // Xcode 27 lists simulators too and moved these fields into `properties`. `reality`
  // is absent on a real device until it has connected, so only "simulated" rules one out.
  const hardware = device => device.properties?.hardware ?? device.hardwareProperties ?? {};
  const watch = devices.map(hardware).find(h => h.platform === "watchOS" && h.reality !== "simulated");
  if (watch) console.log(watch.udid);
' "$output"
