
if [ -f build_paths.sh ]; then
  source ./build_paths.sh
else
  cp build_paths.sh.template build_paths.sh
fi

# Restore the Kotlin prepare hook if a package install removed it.
node "$(dirname "${BASH_SOURCE[0]}")/install-hooks.cjs"
