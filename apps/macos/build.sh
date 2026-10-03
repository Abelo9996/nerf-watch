#!/usr/bin/env bash
# Builds "Nerf Watch.app" (universal, ad-hoc signed) and zips it as build/NerfWatch-macOS.zip.
#
#   apps/macos/build.sh             # version from Support/Info.plist
#   VERSION=0.2.0 apps/macos/build.sh
#
# Needs Swift 6 (Xcode 16 or the Command Line Tools). No third-party dependencies.
set -euo pipefail

cd "$(dirname "$0")"
OUT="build"
APP="$OUT/Nerf Watch.app"
ZIP="$OUT/NerfWatch-macOS.zip"
ARCHS="${ARCHS:-arm64 x86_64}"

rm -rf "$APP" "$ZIP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

binaries=()
for arch in $ARCHS; do
  echo "Building $arch"
  swift build -c release --triple "$arch-apple-macosx13.0"
  binaries+=(".build/$arch-apple-macosx/release/NerfWatch")
done
lipo -create "${binaries[@]}" -output "$APP/Contents/MacOS/NerfWatch"

cp Support/Info.plist "$APP/Contents/Info.plist"
if [[ -n "${VERSION:-}" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${VERSION#v}" "$APP/Contents/Info.plist"
fi
if [[ -n "${BUILD_NUMBER:-}" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$APP/Contents/Info.plist"
fi
printf 'APPL????' > "$APP/Contents/PkgInfo"

# Ad-hoc signature: required to run on Apple silicon. The app is not notarized,
# so the first launch needs right-click > Open (see the README).
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict "$APP"

ditto -c -k --keepParent "$APP" "$ZIP"
echo "Built $ZIP ($(lipo -archs "$APP/Contents/MacOS/NerfWatch"))"
