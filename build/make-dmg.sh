#!/usr/bin/env bash
# Makes a .dmg for each packaged Mac app with Apple's hdiutil, retrying only this step.
# GitHub's macOS machines sometimes keep new disk images busy (XProtect scanning). If every
# attempt fails, this still exits successfully: electron-builder's .zip is always produced.
set -uo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
made=0
for pair in "mac:x64" "mac-arm64:arm64"; do
  app="dist/${pair%%:*}/DriveDesk.app"
  arch="${pair##*:}"
  [ -d "$app" ] || continue
  out="dist/DriveDesk-$VERSION-mac-$arch.dmg"
  stage=$(mktemp -d)
  ditto "$app" "$stage/DriveDesk.app"          # keeps symlinks and the signature intact
  ln -s /Applications "$stage/Applications"     # drag-to-install shortcut
  for attempt in 1 2 3 4 5; do
    if hdiutil create -volname "DriveDesk" -srcfolder "$stage" -ov -format UDZO "$out"; then
      made=$((made + 1)); echo "Made $out"; break
    fi
    echo "hdiutil attempt $attempt for $arch failed; retrying"
    rm -f "$out"
    sudo pkill -9 XProtect >/dev/null 2>&1 || true
    sleep 10
  done
  rm -rf "$stage"
done
echo "Disk images made: $made (the .zip files are available either way)"
exit 0
