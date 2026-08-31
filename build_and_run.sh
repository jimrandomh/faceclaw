#!/bin/bash
cd "$(dirname "$0")"; source scripts/before_build.sh

npx nativescript build android "$@" && \
  adb connect "$DEVICE_ID" >/dev/null && \
  nativescript run android --device "$DEVICE_ID" --justlaunch

