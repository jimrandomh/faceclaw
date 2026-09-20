#!/bin/bash
# Pull faceclaw's JSONC settings off the attached device.
# Usage: pull_config.sh [output-file] [-f output-file] [adb-options...]
#
# Uses the adb-only settings-port receiver to export a consistent snapshot.
set -euo pipefail
umask 077

source "$(cd "$(dirname "$0")" && pwd)/adbutil.sh"

usage() {
    cat <<EOF
Usage: $(basename "$0") [output-file] [-f output-file] [adb-options...]

Pull faceclaw's JSONC settings off the attached device into output-file
(default: faceclaw_settings.jsonc). The output file may be given as a bare
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
OUT="${ADBUTIL_FILE:-faceclaw_settings.jsonc}"
EXPORT_REMOTE=/sdcard/Android/data/$PACKAGE/files/faceclaw-settings-export.jsonc

MODE="$(adb_preflight "$PACKAGE")"

# Use the store on debug builds too: this performs first-launch migration and
# synchronizes export with any in-flight settings writes.
RESULT="$(adb shell am broadcast -n "$PACKAGE/.FaceclawSettingsPortReceiver" \
    -a com.faceclaw.app.SETTINGS_EXPORT)"
if ! printf '%s' "$RESULT" | grep -q 'data="exported:'; then
    printf '%s\n' "$RESULT" >&2
    echo "Error: export broadcast did not report success (old app version?)" >&2
    exit 1
fi
trap 'adb shell rm -f "$EXPORT_REMOTE" >/dev/null 2>&1 || true' EXIT
adb pull "$EXPORT_REMOTE" "$OUT" >/dev/null
chmod 600 "$OUT"
echo "Pulled $PREFS to $OUT (schema 2 JSONC)"
