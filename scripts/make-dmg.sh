#!/usr/bin/env bash
# Builds dist/Pulse-<version>-<arch>.dmg from the packaged app.
# Usage: npm run package:universal && npm run dmg
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
APP=$(ls -td dist/Pulse-darwin-*/Pulse.app | head -1)  # newest build
ARCH=$(basename "$(dirname "$APP")" | sed 's/Pulse-darwin-//')
OUT="dist/Pulse-${VERSION}-${ARCH}.dmg"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
# Ad-hoc signature so the app runs on Apple Silicon; there is no Developer ID notarization.
codesign --force --deep --sign - "$APP"
ditto "$APP" "$STAGE/Pulse.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
hdiutil create -volname "Pulse $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
echo "$OUT"
