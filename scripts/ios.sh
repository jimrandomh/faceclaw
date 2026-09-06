#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

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

exec ns "$@"
