#!/bin/bash
# Push a JSONC settings file to faceclaw on the attached device.
# Usage: push_config.sh [input-file] [-f input-file] [adb-options...]
# Normalizes JSONC (or legacy JSON/XML), force-stops, then imports atomically
# through the adb-only settings-port receiver on debug and release builds.
set -euo pipefail
umask 077

source "$(cd "$(dirname "$0")" && pwd)/adbutil.sh"

usage() {
    cat <<EOF
Usage: $(basename "$0") [input-file] [-f input-file] [adb-options...]

Push input-file (default: faceclaw_settings.jsonc) as faceclaw's JSONC
settings on the attached device. The input file may be given as a bare
first argument or with -f anywhere. Any other arguments are passed through
to adb, e.g. -s SERIAL or -t ID to pick one of several attached devices.
EOF
}

adbutil_parse_args "$@"
if [ "$ADBUTIL_HELP" = 1 ]; then
    usage
    exit 0
fi

PACKAGE=com.faceclaw.app
PREFS=files/faceclaw_settings.jsonc
IN="${ADBUTIL_FILE:-faceclaw_settings.jsonc}"
IMPORT_REMOTE=/sdcard/Android/data/$PACKAGE/files/faceclaw-settings-import.jsonc

if [ ! -f "$IN" ]; then
    echo "Error: $IN not found" >&2
    exit 1
fi

NORMALIZED="$(mktemp)"
trap 'rm -f "$NORMALIZED"' EXIT
python3 "$(dirname "$0")/settings_config.py" "$IN" > "$NORMALIZED"
MODE="$(adb_preflight "$PACKAGE")"
trap 'rm -f "$NORMALIZED"; adb shell rm -f "$IMPORT_REMOTE" >/dev/null 2>&1 || true' EXIT
adb shell am force-stop "$PACKAGE"
adb push "$NORMALIZED" "$IMPORT_REMOTE" >/dev/null
RESULT="$(adb shell am broadcast -n "$PACKAGE/.FaceclawSettingsPortReceiver" \
    -a com.faceclaw.app.SETTINGS_IMPORT)"
if ! printf '%s' "$RESULT" | grep -q 'data="imported:'; then
    printf '%s\n' "$RESULT" >&2
    echo "Error: import broadcast did not report success (old app version?)" >&2
    exit 1
fi
echo "Pushed $IN to $PREFS (previous settings kept as $PREFS.previous; relaunch the app)"
