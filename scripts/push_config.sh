#!/bin/bash
# Import a JSON config document (from Android or iOS; see config-transfer.md)
# into faceclaw on the attached Android device.
# Usage: push_config.sh [input-file] [-f input-file] [adb-options...]
#
# The import merges: settings the file doesn't mention are left alone, and
# settings that only make sense on the platform that exported them are left
# out when the file came from iOS. Legacy shared-preferences XML (what this
# script used to take) is converted first. The file is staged in the app's
# external files dir, and FaceclawSettingsPortReceiver (adb-only; see its
# javadoc) validates it, saves the previous settings, applies it, and exits
# the app so its next launch starts from the imported settings.
set -euo pipefail

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPTS/adbutil.sh"

usage() {
    cat <<EOF
Usage: $(basename "$0") [input-file] [-f input-file] [adb-options...]

Import input-file (default: faceclaw_settings.android.json) into faceclaw's
settings on the attached device. The file may be a config pulled from Android
or iOS, or legacy Android shared-preferences XML. It may be given as a bare
first argument or with -f anywhere. Any other arguments are passed through to
adb, e.g. -s SERIAL or -t ID to pick one of several attached devices.
EOF
}

adbutil_parse_args "$@"
if [ "$ADBUTIL_HELP" = 1 ]; then
    usage
    exit 0
fi

PACKAGE=com.faceclaw.app
IN="${ADBUTIL_FILE:-faceclaw_settings.android.json}"
IMPORT_REMOTE=/sdcard/Android/data/$PACKAGE/files/faceclaw-settings-import.json

if [ ! -f "$IN" ]; then
    echo "Error: $IN not found" >&2
    if [ -z "$ADBUTIL_FILE" ] && [ -f faceclaw_settings.xml ]; then
        echo "       (older pull_config.sh wrote faceclaw_settings.xml; pass it explicitly)" >&2
    fi
    exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
    echo "Error: python3 is needed to check the config before pushing it" >&2
    exit 1
fi

umask 077
STAGE="$(mktemp "${TMPDIR:-/tmp}/faceclaw-config.XXXXXX")"
trap 'rm -f "$STAGE"' EXIT
# Validates (and converts legacy XML) before anything touches the device.
python3 "$SCRIPTS/config_document.py" "$IN" > "$STAGE"

adb_preflight "$PACKAGE" >/dev/null

if ! OUTPUT="$(adb push "$STAGE" "$IMPORT_REMOTE" 2>&1)"; then
    printf '%s\n' "$OUTPUT" >&2
    echo "Error: could not stage the config on the device" >&2
    exit 1
fi
RESULT="$(adb shell am broadcast --include-stopped-packages \
    -n "$PACKAGE/.FaceclawSettingsPortReceiver" -a com.faceclaw.app.SETTINGS_IMPORT)"
# The receiver deletes the staged file once read; this covers older builds.
adb shell rm -f "$IMPORT_REMOTE"
if ! printf '%s' "$RESULT" | grep -q 'data="imported:'; then
    # An older build looks for a staged .xml file and reports "nothing staged".
    if printf '%s' "$RESULT" | grep -q 'data="error:' && ! printf '%s' "$RESULT" | grep -q 'nothing staged'; then
        printf '%s\n' "$RESULT" | sed -n 's/.*data="error: \(.*\)"$/Error: \1 (no settings were changed)/p' >&2
    else
        printf '%s\n' "$RESULT" >&2
        echo "Error: import broadcast did not report success (app predates JSON configs?)" >&2
    fi
    exit 1
fi
printf '%s\n' "$RESULT" | sed -n 's/.*data="imported: \(.*\)"$/Imported \1/p'
# The app exits half a second after an import. Wait for that, so that a command
# run straight after this one (pull_config.sh, say) reaches a fresh process
# rather than the exiting one. A restarted process has a new pid. If the cached
# app freezer stops the process before it gets to exit, stop it from here.
PID="$(adb shell pidof "$PACKAGE" 2>/dev/null | tr -d '\r' | awk '{print $1}')"
if [ -n "$PID" ]; then
    adb shell "i=0; while [ -d /proc/$PID ] && [ \$i -lt 50 ]; do sleep 0.1; i=\$((i+1)); done"
    if adb shell "[ -d /proc/$PID ]" 2>/dev/null; then
        adb shell am force-stop "$PACKAGE"
    fi
fi
echo "The app restarts on its next launch with the imported settings."
