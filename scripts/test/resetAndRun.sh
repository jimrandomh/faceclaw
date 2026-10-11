#!/usr/bin/env bash
#
# resetAndRun.sh — rebuild Faceclaw and put a phone into an approximately
# never-had-faceclaw state for onboarding-flow testing, then install and
# launch the fresh build. Unlike resetOnboarding.sh this also forgets the
# glasses/ring Bluetooth pairings, and takes the target device explicitly
# (we test on several phones now, so no hardcoded default).
#
# Steps: build → uninstall → install → unpair "EVEN R1*" / "Even G2*" bonds
# → wipe app data + reset BLUETOOTH_CONNECT to undecided → launch.
#
# Usage:
#   scripts/resetAndRun.sh <adb-device-id>     # serial or host:port
#
# Android has no adb command to remove a Bluetooth bond, so the unpair step
# works through FaceclawDebugUnpairReceiver inside the app: we install the
# fresh build first, temporarily `pm grant` BLUETOOTH_CONNECT, broadcast the
# unpair request, then `pm clear` + revoke so the app still looks
# freshly-installed when it launches.

set -euo pipefail

PACKAGE="com.faceclaw.app"
UNPAIR_PREFIXES="EVEN R1,Even G2"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
APK="$ROOT/platforms/android/app/build/outputs/apk/debug/app-debug.apk"

if [ $# -ne 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
DEVICE_ID="$1"

# Match build.sh's tool locations so adb is on PATH even from a bare shell.
export ANDROID_HOME="${ANDROID_HOME:-/Users/jbabcock/Library/Android/sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

ADB="adb -s $DEVICE_ID"

# Network devices (host:port) need an explicit connect first.
case "$DEVICE_ID" in
  *:*) adb connect "$DEVICE_ID" >/dev/null ;;
esac

if ! $ADB get-state >/dev/null 2>&1; then
  echo "error: adb device '$DEVICE_ID' not connected." >&2
  echo "       Connected devices:" >&2
  adb devices -l | sed '1d' >&2
  exit 1
fi

echo "==> Building..."
"$ROOT/build.sh"
[ -f "$APK" ] || { echo "error: build produced no APK at $APK" >&2; exit 1; }

echo "==> Uninstalling $PACKAGE..."
$ADB uninstall "$PACKAGE" >/dev/null 2>&1 || echo "    (was not installed)"

echo "==> Installing $(basename "$APK")..."
$ADB install "$APK"

echo "==> Unpairing Bluetooth devices matching: $UNPAIR_PREFIXES"
# The receiver needs BLUETOOTH_CONNECT; grant it just for this step. The
# whole remote command must be ONE quoted string — adb flattens multi-arg
# commands, which would lose the quoting around the space-containing extras.
$ADB shell pm grant "$PACKAGE" android.permission.BLUETOOTH_CONNECT
UNPAIR_OUT="$($ADB shell "am broadcast -n $PACKAGE/.FaceclawDebugUnpairReceiver \
  -a com.faceclaw.app.action.DEBUG_UNPAIR --es prefixes '$UNPAIR_PREFIXES'")"
UNPAIR_RESULT="$(printf '%s\n' "$UNPAIR_OUT" | sed -n 's/.*data="\(.*\)".*/\1/p')"
echo "    ${UNPAIR_RESULT:-no result from unpair receiver: $UNPAIR_OUT}"
case "$UNPAIR_RESULT" in
  error:*|"") echo "    WARNING: unpair step did not run cleanly; pairings may remain." >&2 ;;
esac

# Return the app to fresh-install state: the broadcast booted the app process
# (which may have written data), and the grant above must not leak into the
# onboarding permissions test. clear-permission-flags removes the user-set
# mark pm revoke leaves, so the permission dialog is still allowed to appear.
echo "==> Resetting app data and permissions to fresh-install state..."
$ADB shell am force-stop "$PACKAGE"
$ADB shell pm clear "$PACKAGE" >/dev/null
$ADB shell pm revoke "$PACKAGE" android.permission.BLUETOOTH_CONNECT
$ADB shell pm clear-permission-flags "$PACKAGE" \
  android.permission.BLUETOOTH_CONNECT user-set user-fixed

echo "==> Launching..."
$ADB shell am start -n "$PACKAGE/com.tns.NativeScriptActivity" >/dev/null
echo "Done. Faceclaw should be starting its first-run onboarding."
