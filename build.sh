#!/usr/bin/env bash
#
# Build, package, and zip the WeatherMap App View for upload to NetOps Portal.
# Run from the project root (the directory containing package.json).
#
# Make executable once with:
#     chmod +x build.sh
# Then run with:
#     ./build.sh
#
# Optional: set SCP_TARGET to scp the resulting WeatherMap.zip somewhere.
#   SCP_TARGET=user@host:/path ./build.sh   # copy to that location
#   SCP_TARGET=none ./build.sh              # skip the scp step
#   ./build.sh                              # uses the default below

set -euo pipefail

SCP_TARGET="${SCP_TARGET:-omar.ocampo@34.168.120.10:~/.}"

# Sanity check — make sure we're in the project root
if [[ ! -f package.json ]]; then
    echo "Error: no package.json found in $(pwd)" >&2
    echo "Run this script from the WeatherMap-NetOps project root." >&2
    exit 1
fi

echo "→ Building with Vite..."
npm run build

echo "→ Cleaning previous package..."
rm -rf WeatherMap WeatherMap.zip

echo "→ Renaming dist/ to WeatherMap/..."
mv dist WeatherMap

echo "→ Zipping WeatherMap/..."
zip -rq WeatherMap.zip WeatherMap

if [[ "$SCP_TARGET" == "none" ]]; then
    echo "→ Skipping scp (SCP_TARGET=none)."
else
    echo "→ SCP to $SCP_TARGET ..."
    scp WeatherMap.zip "$SCP_TARGET"
fi

echo ""
echo "✓ Done. Built $(du -h WeatherMap.zip | cut -f1) — WeatherMap.zip"
echo "  Upload via Administration → Configuration Settings → App Deployment."
