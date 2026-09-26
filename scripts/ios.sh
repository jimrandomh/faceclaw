#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Kotlin/Native also needs the JDK; share the existing local build environment.
if [[ -f build_paths.sh ]]; then
  source ./build_paths.sh
fi

# Prefer Homebrew Ruby over the older macOS system Ruby when available.
for ruby_bin in /opt/homebrew/opt/ruby/bin /usr/local/opt/ruby/bin; do
  if [[ -x "$ruby_bin/ruby" ]]; then
    export PATH="$ruby_bin:$PATH"
    break
  fi
done
if command -v ruby >/dev/null 2>&1; then
  gem_bin="$(ruby -e 'puts Gem.bindir')"
  export PATH="$gem_bin:$PATH"
fi

node scripts/install-hooks.cjs
exec ns "$@"
