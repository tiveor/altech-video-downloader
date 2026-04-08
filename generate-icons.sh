#!/bin/bash
# Generates PNG icons from SVG using rsvg-convert or Inkscape
# Run: bash generate-icons.sh

SVG="icons/icon16.svg"

for size in 16 48 128; do
  if command -v rsvg-convert &>/dev/null; then
    rsvg-convert -w $size -h $size icons/icon16.svg -o icons/icon${size}.png
  elif command -v inkscape &>/dev/null; then
    inkscape --export-type=png --export-width=$size --export-height=$size \
      --export-filename=icons/icon${size}.png icons/icon16.svg
  elif command -v convert &>/dev/null; then
    # ImageMagick: render SVG at size
    convert -background none -resize ${size}x${size} icons/icon16.svg icons/icon${size}.png
  else
    echo "No SVG-to-PNG converter found. Install imagemagick, inkscape, or librsvg."
    exit 1
  fi
  echo "Generated icons/icon${size}.png"
done
