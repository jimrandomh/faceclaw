#!/bin/bash
# Push a shared-preferences file to faceclaw on the attached device.
# Usage: push_config.sh [input-file] [-f input-file] [adb-options...]
# Validates the XML, force-stops the app (so a running instance doesn't
# overwrite the pushed file from its in-memory prefs), then installs it.
#
# Uses run-as on debuggable (dev) builds. On release builds, where run-as is
# refused, falls back to the FaceclawSettingsPortReceiver broadcast: the file
# is staged in the app's external files dir and the receiver (adb-only; see
# its javadoc) validates and installs it, then exits so the next launch
# re-reads settings from disk.
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/adbutil.sh"

usage() {
    cat <<EOF
Usage: $(basename "$0") [input-file] [-f input-file] [adb-options...]

Push input-file (default: faceclaw_settings.xml) as faceclaw's shared
preferences on the attached device. The input file may be given as a bare
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
PREFS=shared_prefs/faceclaw_settings.xml
IN="${ADBUTIL_FILE:-faceclaw_settings.xml}"
STAGE=/data/local/tmp/faceclaw_settings_push.xml
IMPORT_REMOTE=/sdcard/Android/data/$PACKAGE/files/faceclaw-settings-import.xml

if [ ! -f "$IN" ]; then
    echo "Error: $IN not found" >&2
    exit 1
fi

if command -v xmllint >/dev/null 2>&1; then
    xmllint --noout "$IN"
elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys, xml.etree.ElementTree as ET; ET.parse(sys.argv[1])' "$IN"
else
    echo "Error: need xmllint or python3 to validate XML" >&2
    exit 1
fi

MODE="$(adb_preflight "$PACKAGE")"

adb shell am force-stop "$PACKAGE"

if [ "$MODE" = debug ]; then
    adb push "$IN" "$STAGE"
    adb shell run-as "$PACKAGE" cp "$STAGE" "$PREFS"
    adb shell rm "$STAGE"
    echo "Pushed $IN to $PREFS (app was force-stopped; relaunch it to pick up the new settings)"
else
    echo "Release build installed; using settings-port broadcast..."
    adb push "$IN" "$IMPORT_REMOTE" >/dev/null
    RESULT="$(adb shell am broadcast -n "$PACKAGE/.FaceclawSettingsPortReceiver" \
        -a com.faceclaw.app.SETTINGS_IMPORT)"
    if ! printf '%s' "$RESULT" | grep -q 'data="imported:'; then
        printf '%s\n' "$RESULT" >&2
        adb shell rm -f "$IMPORT_REMOTE"
        echo "Error: import broadcast did not report success (old app version?)" >&2
        exit 1
    fi
    echo "Pushed $IN to $PREFS via settings-port import (previous settings kept as $PREFS.bak)"
fi
