#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/before_build.sh
if [ "$#" -eq 0 ]; then
  set -- testAndroidHostTest
fi
exec ./wear/gradlew -p tests/kotlin "$@"
