#!/bin/sh
# Package the built .app into a compressed DMG (with an /Applications shortcut).
# More robust than Tauri's Finder-scripted DMG step, which can fail with "Resource busy".
# Usage: scripts/make-dmg.sh [path/to/Nonlinear.app] [out.dmg]
set -eu
APP="${1:-apps/desktop/src-tauri/target/release/bundle/macos/Nonlinear.app}"
VER=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP/Contents/Info.plist")
ARCH=$(lipo -archs "$APP/Contents/MacOS/nonlinear-desktop" | tr ' ' '_')
OUT="${2:-apps/desktop/src-tauri/target/release/bundle/Nonlinear_${VER}_${ARCH}.dmg}"
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
for i in 1 2 3; do
  hdiutil create -quiet -volname "Nonlinear" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$OUT" && break
  echo "hdiutil busy, retrying ($i)…"; sleep 3
done
rm -rf "$STAGE"
hdiutil verify -quiet "$OUT"
echo "$OUT"
