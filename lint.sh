#!/bin/bash
# Lint the TypeScript sources with oxlint. Which files get linted (TypeScript
# only) and which rules are enabled are both set in .oxlintrc.json.
# Arguments are passed through to oxlint, e.g. `./lint.sh --fix` or
# `./lint.sh app/g2` to lint only some paths.
cd "$(dirname "$0")"

exec node_modules/.bin/oxlint "$@"
