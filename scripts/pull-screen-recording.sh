#!/bin/bash
# Copy screen recordings (the phone app's "Record screen") from the phone to the current
# directory: the newest one, or every one with --all. Other arguments go to adb (e.g. -s <id>).
# Open the result in tools/screen-recording-visualizer/index.html.
set -euo pipefail
all=false
adb_args=()
for arg in "$@"; do
  if [ "$arg" = "--all" ]; then all=true; else adb_args+=("$arg"); fi
done
dir=/sdcard/Android/data/com.faceclaw.app/files/screenshots
files=$(adb ${adb_args[@]+"${adb_args[@]}"} shell "ls $dir" | tr -d '\r' | grep '^recording-.*\.fcrec\.jsonl$' | sort || true)
if [ -z "$files" ]; then
  echo "No screen recordings in $dir" >&2
  exit 1
fi
if [ "$all" = false ]; then files=$(echo "$files" | tail -n 1); fi
for file in $files; do
  adb ${adb_args[@]+"${adb_args[@]}"} pull "$dir/$file" .
done
