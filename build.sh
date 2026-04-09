#!/bin/bash
# Build script for Chrome Web Store distribution
# Usage: bash build.sh

set -e

VERSION=$(grep '"version"' manifest.json | sed 's/.*: *"\(.*\)".*/\1/')
OUTPUT="altech-video-downloader-v${VERSION}.zip"

echo "Building Altech Video Downloader v${VERSION}..."

# Regenerate icons from SVG
bash generate-icons.sh

# Remove previous build if exists
rm -f "$OUTPUT"

# Create zip excluding dev files
zip -r "$OUTPUT" \
  manifest.json \
  background.js \
  content.js \
  offscreen.html \
  offscreen.js \
  popup.html \
  popup.css \
  popup.js \
  icons/icon16.png \
  icons/icon48.png \
  icons/icon128.png \
  lib/

echo ""
echo "Build complete: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
