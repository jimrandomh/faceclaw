#!/bin/bash
# Export faceclaw's settings from the attached Android device as a JSON config
# document (the same format as pull_config_ios.sh; see config-transfer.md).
# Usage: pull_config.sh [output-file] [-f output-file] [adb-options...]
#
# The app's FaceclawSettingsPortReceiver writes the document into its external
# files dir for adb to pull. Only the adb shell can trigger it (see the
# receiver's javadoc), and it works on release builds, where run-as is refused.
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/adbutil.sh"

usage() {
    cat <<EOF
Usage: $(basename "$0") [output-file] [-f output-file] [adb-options...]

Export faceclaw's settings from the attached device into output-file
(default: faceclaw_settings.android.json), readable only by you. The output
file may be given as a bare first argument or with -f anywhere. Any other
arguments are passed through to adb, e.g. -s SERIAL or -t ID to pick one of
several attached devices. Push the file to Android or iOS with push_config.sh
or push_config_ios.sh.
EOF
}

adbutil_parse_args "$@"
if [ "$ADBUTIL_HELP" = 1 ]; then
    usage
    exit 0
fi

PACKAGE=com.faceclaw.app
OUT="${ADBUTIL_FILE:-faceclaw_settings.android.json}"
EXPORT_REMOTE=/sdcard/Android/data/$PACKAGE/files/faceclaw-settings-export.json

case "$OUT" in
    *.xml|*.XML)
        echo "Error: configs are exported as JSON; choose a .json filename" >&2
        exit 1
        ;;
esac

adb_preflight "$PACKAGE" >/dev/null

export_broadcast() {
    adb shell am broadcast --include-stopped-packages \
        -n "$PACKAGE/.FaceclawSettingsPortReceiver" -a com.faceclaw.app.SETTINGS_EXPORT
}
RESULT="$(export_broadcast)"
if ! printf '%s' "$RESULT" | grep -q 'data='; then
    # No reply at all: the broadcast reached a process that was exiting (the
    # app exits just after an import). Try once more in a fresh one.
    adb shell sleep 1
    RESULT="$(export_broadcast)"
fi
if ! printf '%s' "$RESULT" | grep -q 'data="exported: .*\.json"'; then
    printf '%s\n' "$RESULT" >&2
    echo "Error: export broadcast did not report a JSON export (app predates JSON configs?)" >&2
    exit 1
fi

# The export contains API tokens: keep it private locally, and don't leave it
# sitting on shared storage.
umask 077
TMP="$(mktemp "$OUT.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
if ! OUTPUT="$(adb pull "$EXPORT_REMOTE" "$TMP" 2>&1)"; then
    adb shell rm -f "$EXPORT_REMOTE"
    printf '%s\n' "$OUTPUT" >&2
    echo "Error: could not pull $EXPORT_REMOTE" >&2
    exit 1
fi
adb shell rm -f "$EXPORT_REMOTE"
mv "$TMP" "$OUT"
trap - EXIT
echo "Pulled settings to $OUT (mode 600)"
