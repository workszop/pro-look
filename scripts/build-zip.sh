#!/usr/bin/env bash
# Build dist/pro-look.zip: only the files Chrome needs, inside a single "pro-look" folder.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

FILES=(manifest.json background.js options.html options.js content icons)

mkdir -p "$STAGE/pro-look" "$DIST"
for f in "${FILES[@]}"; do cp -R "$ROOT/$f" "$STAGE/pro-look/"; done
rm -f "$DIST/pro-look.zip"
(cd "$STAGE" && zip -qr -X "$DIST/pro-look.zip" pro-look)
echo "$DIST/pro-look.zip"
