#!/usr/bin/env bash
# Builds the virtual display helper. Requires Xcode Command Line Tools: xcode-select --install
#   ./build.sh              -> native arch only (fast, for development)
#   ./build.sh --universal  -> Apple silicon + Intel in one binary (for installers)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
FLAGS=(-O -import-objc-header CGVirtualDisplay.h -framework Foundation -framework CoreGraphics vdisplay.swift)

if [[ "${1:-}" == "--universal" ]]; then
  swiftc "${FLAGS[@]}" -target arm64-apple-macos11 -o build/vdisplay-arm64
  swiftc "${FLAGS[@]}" -target x86_64-apple-macos11 -o build/vdisplay-x86_64
  lipo -create build/vdisplay-arm64 build/vdisplay-x86_64 -output build/vdisplay
  rm build/vdisplay-arm64 build/vdisplay-x86_64
else
  swiftc "${FLAGS[@]}" -o build/vdisplay
fi
codesign --force --sign - build/vdisplay
echo "Built $(pwd)/build/vdisplay"
echo "Test it:  ./build/vdisplay --width 2200 --height 1300   (Ctrl+C removes the display)"
