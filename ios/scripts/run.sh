#!/bin/bash
# Build InfiniZine for the iPad simulator, install it and launch it; extra args go to the app
# (e.g. -izineMousePencil to draw with the mouse, -izineLogStrokes, -izineTest native|web).
# SIM=<udid> picks the simulator (default: the first booted iPad, else an iPad Pro 11-inch (M4)).
set -e
cd "$(dirname "$0")/.."
SIM=${SIM:-$(xcrun simctl list devices booted | grep -m1 'iPad' | grep -o '[0-9A-F-]\{36\}' || true)}
SIM=${SIM:-$(xcrun simctl list devices available | grep -m1 'iPad Pro 11-inch (M4) (' | grep -o '[0-9A-F-]\{36\}')}
xcrun simctl boot "$SIM" 2>/dev/null || true
open -a Simulator
[ -d InfiniZine.xcodeproj ] || xcodegen generate
xcodebuild -project InfiniZine.xcodeproj -scheme InfiniZine -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIM" -derivedDataPath build build -quiet
xcrun simctl terminate "$SIM" app.infinizine.ipad 2>/dev/null || true
xcrun simctl install "$SIM" build/Build/Products/Debug-iphonesimulator/InfiniZine.app
xcrun simctl launch --console-pty "$SIM" app.infinizine.ipad "$@"
