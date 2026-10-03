#!/usr/bin/env bash
# Runs the unit tests (Swift Testing). With Xcode this is plain `swift test`.
# The Command Line Tools ship Testing.framework outside the default search path,
# and some releases lack the Foundation cross-import overlay, so add both flags there.
set -euo pipefail
cd "$(dirname "$0")"

FW="$(xcode-select -p)/Library/Developer/Frameworks"
if [[ "$(xcode-select -p)" == *CommandLineTools* && -d "$FW/Testing.framework" ]]; then
  exec swift test \
    -Xswiftc -F -Xswiftc "$FW" \
    -Xswiftc -Xfrontend -Xswiftc -disable-cross-import-overlays \
    -Xlinker -F -Xlinker "$FW" -Xlinker -rpath -Xlinker "$FW" "$@"
fi
exec swift test "$@"
