#!/bin/bash
# Pull faceclaw's shared preferences off the attached device.
# Usage: pull_config.sh [output-file] [-f output-file] [adb-options...]
#
# Uses run-as on debuggable (dev) builds. On release builds, where run-as is
# refused, falls back to the FaceclawSettingsPortReceiver broadcast, which
# copies the settings file into the app's external files dir for adb to pull
# (and which only the adb shell can trigger; see the receiver's javadoc).
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/adbutil.sh"

usage() {
    cat <<EOF
Usage: $(basename "$0") [output-file] [-f output-file] [adb-options...]

Pull faceclaw's shared preferences off the attached device into output-file
(default: faceclaw_settings.xml). The output file may be given as a bare
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
OUT="${ADBUTIL_FILE:-faceclaw_settings.xml}"
EXPORT_REMOTE=/sdcard/Android/data/$PACKAGE/files/faceclaw-settings-export.xml

MODE="$(adb_preflight "$PACKAGE")"

if [ "$MODE" = debug ]; then
    adb exec-out run-as "$PACKAGE" cat "$PREFS" > "$OUT"
    echo "Pulled $PREFS to $OUT"
else
    echo "Release build installed; using settings-port broadcast..."
    RESULT="$(adb shell am broadcast -n "$PACKAGE/.FaceclawSettingsPortReceiver" \
        -a com.faceclaw.app.SETTINGS_EXPORT)"
    if ! printf '%s' "$RESULT" | grep -q 'data="exported:'; then
        printf '%s\n' "$RESULT" >&2
        echo "Error: export broadcast did not report success (old app version?)" >&2
        exit 1
    fi
    adb pull "$EXPORT_REMOTE" "$OUT" >/dev/null
    # The export contains API tokens; don't leave it sitting on shared storage.
    adb shell rm "$EXPORT_REMOTE"
    echo "Pulled $PREFS to $OUT (via settings-port export)"
fi
