#!/usr/bin/env bash
#
# resetOnboarding.sh — reset Faceclaw on an attached phone back to its
# pre-onboarding state, for testing the onboarding flow repeatedly.
#
# By default this only clears the onboarding-related preference keys
# (onboarding.complete, onboarding.previewOnly, the on-glasses onboarding's
# onboarding.glassesFinishedVersion, ...) and leaves everything
# else — notably the saved glasses/ring MAC addresses — intact, so you don't
# have to re-scan devices on every test pass. Pass --all to wipe ALL app data
# (a true fresh-install state, addresses included).
#
# Usage:
#   scripts/resetOnboarding.sh                 # reset onboarding flags only
#   scripts/resetOnboarding.sh --all           # full `pm clear` (wipes everything)
#   scripts/resetOnboarding.sh -s <device-id>  # target a specific adb device
#
# The device id defaults to $FACECLAW_DEVICE_ID, then to the id used by
# build_and_run.sh. adb is located the same way build.sh finds its tools.

set -euo pipefail

PACKAGE="com.faceclaw.app"
PREF_KEY_PREFIX="onboarding."
DEVICE_ID="${FACECLAW_DEVICE_ID:-3A101JEHN12330}"
WIPE_ALL=0

# Match build.sh's tool locations so adb is on PATH even from a bare shell.
export ANDROID_HOME="${ANDROID_HOME:-/Users/jbabcock/Library/Android/sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

while [ $# -gt 0 ]; do
  case "$1" in
    --all)        WIPE_ALL=1; shift ;;
    -s|--device)  DEVICE_ID="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "unknown option: $1 (try --help)" >&2
      exit 2 ;;
  esac
done

command -v adb >/dev/null 2>&1 || { echo "error: adb not found on PATH" >&2; exit 1; }

ADB="adb -s $DEVICE_ID"

# Confirm the device is actually there before doing anything.
if ! $ADB get-state >/dev/null 2>&1; then
  echo "error: adb device '$DEVICE_ID' not connected." >&2
  echo "       Connected devices:" >&2
  adb devices -l | sed '1d' >&2
  exit 1
fi

if [ "$WIPE_ALL" -eq 1 ]; then
  echo "Wiping ALL app data for $PACKAGE (fresh-install state)..."
  $ADB shell pm clear "$PACKAGE"
  echo "Done. The next launch starts from a clean onboarding."
  exit 0
fi

# Surgical reset: strip only the onboarding.* keys from the app's
# SharedPreferences XML, preserving saved device addresses and other settings.
# This needs run-as, which works for debuggable (sideloaded/dev) builds.
if ! $ADB shell run-as "$PACKAGE" true >/dev/null 2>&1; then
  echo "run-as is unavailable for $PACKAGE (release build?)." >&2
  echo "Falling back to a full data wipe; re-run with --all to silence this." >&2
  $ADB shell pm clear "$PACKAGE"
  echo "Done (full wipe)."
  exit 0
fi

echo "Clearing onboarding preference keys ($PREF_KEY_PREFIX*) for $PACKAGE..."

# Force-stop first so the running app can't flush its in-memory preferences
# back over the files after we edit them.
$ADB shell am force-stop "$PACKAGE"

# List the shared_prefs XML files, then strip matching <... name="onboarding...">
# entries from each. toybox sed (present on modern Android) supports -i.
# Note: each remote command is passed to `adb shell` as ONE quoted string --
# adb joins multiple args with spaces without re-quoting, so inner quoting
# (e.g. sh -c '...') gets flattened and re-tokenized by the device shell.
FILES="$($ADB shell "run-as $PACKAGE ls shared_prefs 2>/dev/null" | tr -d '\r' || true)"
if [ -z "$FILES" ]; then
  echo "No shared_prefs found; the app may not have run yet. Nothing to do."
  exit 0
fi

CHANGED=0
for f in $FILES; do
  case "$f" in
    *.xml) ;;
    *) continue ;;
  esac
  if $ADB shell "run-as $PACKAGE grep -q 'name=\"$PREF_KEY_PREFIX' shared_prefs/$f" >/dev/null 2>&1; then
    $ADB shell "run-as $PACKAGE sed -i '/name=\"$PREF_KEY_PREFIX/d' shared_prefs/$f"
    echo "  cleared onboarding keys in shared_prefs/$f"
    CHANGED=1
  fi
done

if [ "$CHANGED" -eq 1 ]; then
  echo "Done. Relaunch Faceclaw to go through onboarding again."
else
  echo "No onboarding keys were set. App is already in pre-onboarding state."
fi
