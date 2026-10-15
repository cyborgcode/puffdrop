#!/bin/bash
# Build the GNOME Shell extension as a zip that any extension manager, or
# `gnome-extensions install`, can install. The zip holds only the panel; the
# omdrop command it drives comes from `bin/omdrop setup` in this checkout.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$ROOT/dist}
mkdir -p "$OUT"
gnome-extensions pack --force --out-dir="$OUT" \
  --extra-source=cli.js --extra-source=radar.js --extra-source=icons \
  "$ROOT/extension"
ls "$OUT"/*.shell-extension.zip
