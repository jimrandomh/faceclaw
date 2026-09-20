# Sourceable adb helper functions shared by the scripts/ utilities.
# Not a standalone script; use:  source "$(dirname "$0")/adbutil.sh"

# Extra arguments (e.g. -s SERIAL) inserted before every adb subcommand.
# Filled in by adbutil_parse_args; the wrapper below makes them apply to all
# plain `adb ...` calls in the sourcing script.
ADB_ARGS=()
adb() {
    command adb ${ADB_ARGS[@]+"${ADB_ARGS[@]}"} "$@"
}

# adbutil_parse_args "$@"
#
# Shared command-line parsing for the settings-port scripts. Sets:
#   ADBUTIL_FILE  - local settings file: a bare first argument, or the value
#                   of -f FILE anywhere in the argument list; empty if neither
#                   was given (caller applies its default)
#   ADBUTIL_HELP  - 1 if -h/--help appeared anywhere, else 0
# Everything else is collected into ADB_ARGS and passed through to adb
# (e.g. -s SERIAL or -t ID to pick one of several attached devices).
adbutil_parse_args() {
    ADBUTIL_FILE=""
    ADBUTIL_HELP=0
    local first=1
    while [ $# -gt 0 ]; do
        case "$1" in
            -h|--help)
                ADBUTIL_HELP=1
                ;;
            -f)
                if [ $# -lt 2 ]; then
                    echo "Error: -f requires a filename" >&2
                    return 1
                fi
                ADBUTIL_FILE="$2"
                shift
                ;;
            -*)
                ADB_ARGS+=("$1")
                ;;
            *)
                # A bare first argument is the filename; later bare arguments
                # are passed through (they're values for adb flags like -s).
                if [ "$first" = 1 ]; then
                    ADBUTIL_FILE="$1"
                else
                    ADB_ARGS+=("$1")
                fi
                ;;
        esac
        first=0
        shift
    done
}

# adb_preflight <package>
#
# Checks that adb exists, exactly one device is reachable, and <package> is
# installed, then prints the install mode on stdout:
#   debug    - debuggable build; run-as works
#   release  - installed but not debuggable; run-as is refused
# Any other condition prints a diagnosis to stderr and returns nonzero (which
# aborts callers running under `set -e`).
adb_preflight() {
    local package="$1"
    local state

    # type -P checks PATH only, so the adb wrapper function above doesn't
    # satisfy the check.
    if ! type -P adb >/dev/null 2>&1; then
        echo "Error: adb not found on PATH" >&2
        return 1
    fi

    # get-state fails outright when there is no device or more than one, and
    # reports states like "offline" / "unauthorized" for unusable ones.
    if ! state="$(adb get-state 2>&1)"; then
        echo "Error: no usable adb device ($state)." >&2
        echo "       Connected devices:" >&2
        adb devices -l | sed '1d;/^$/d' >&2
        return 1
    fi
    if [ "$state" != "device" ]; then
        echo "Error: adb device is in state '$state' (offline/unauthorized?)" >&2
        return 1
    fi

    # grep rather than pm's exit code: exit-code propagation over `adb shell`
    # needs shell protocol v2, which very old adb binaries lack.
    if ! adb shell pm path "$package" 2>/dev/null | grep -q "^package:"; then
        echo "Error: $package is not installed on this device" >&2
        return 1
    fi

    if adb shell run-as "$package" true >/dev/null 2>&1; then
        echo debug
    else
        echo release
    fi
}
