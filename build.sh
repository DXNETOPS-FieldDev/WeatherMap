#!/usr/bin/env bash
#
# Build, package, and zip the WeatherMap App View for upload to NetOps Portal.
# Run from the project root (the directory containing package.json).
#
# Make executable once with:
#     chmod +x build.sh
# Then run with:
#     SCP_TARGET=user@host:/path ./build.sh   # build + scp to that location
#     SCP_TARGET=none ./build.sh              # build only, no scp

set -euo pipefail

if [[ ! -f package.json ]]; then
    echo "Error: no package.json found in $(pwd)" >&2
    echo "Run this script from the WeatherMap-NetOps project root." >&2
    exit 1
fi

if [[ -z "${SCP_TARGET:-}" ]]; then
    echo "Error: SCP_TARGET is not set." >&2
    echo "" >&2
    echo "  Example: export SCP_TARGET=<user>@<portal-host>:~/." >&2
    echo "  Skip:    export SCP_TARGET=none" >&2
    exit 1
fi

echo "→ Building with Vite..."
npm run build

echo "→ Cleaning previous package..."
rm -rf WeatherMap WeatherMap.zip

echo "→ Renaming dist/ to WeatherMap/..."
mv dist WeatherMap

# vite copies public/ verbatim into dist/, including any real
# .properties files a developer has locally for their own testing
# (gitignored from git, but not excluded from the build). Strip them
# so a release build never ships real credentials — only the
# .example templates a customer is meant to copy and fill in.
echo "→ Removing local dev credentials from the package (keeping .example templates)..."
rm -f WeatherMap/spectrum-proxy.properties WeatherMap/appneta-proxy.properties WeatherMap/da-proxy.properties

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
