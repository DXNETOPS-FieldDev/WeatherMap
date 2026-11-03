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
#
# CHANNEL=beta builds "NetOps WeatherMap (Beta)" into WeatherMapBeta/ and
# WeatherMapBeta.zip instead: a separate App View that installs NEXT TO the
# stable one rather than over it (App Deployment keys apps by their folder),
# with its own runtime-config.json and its own credential files.
#     CHANNEL=beta SCP_TARGET=none ./build.sh

set -euo pipefail

CHANNEL="${CHANNEL:-stable}"
case "$CHANNEL" in
    stable) APP_DIR=WeatherMap ;;
    beta)   APP_DIR=WeatherMapBeta ;;
    *)
        echo "Error: CHANNEL must be 'stable' or 'beta' (got '$CHANNEL')." >&2
        exit 1
        ;;
esac

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
rm -rf "$APP_DIR" "$APP_DIR.zip"

echo "→ Renaming dist/ to $APP_DIR/..."
mv dist "$APP_DIR"

# vite copies public/ verbatim into dist/, including any real
# .properties files a developer has locally for their own testing
# (gitignored from git, but not excluded from the build). Strip them
# so a release build never ships real credentials — only the
# .example templates a customer is meant to copy and fill in.
echo "→ Removing local dev credentials from the package (keeping .example templates)..."
rm -f "$APP_DIR"/*-proxy.properties

if [[ "$CHANNEL" == "beta" ]]; then
    # A distinct name in the App View dropdown, and a BETA tag in the map's
    # status banner (runtime-config "releaseChannel"), so the two can't be
    # mistaken for each other.
    echo "→ Marking the package as the beta App View..."
    sed -i.bak -e 's/^appName=.*/appName=NetOps WeatherMap (Beta)/' \
        -e 's/^description=/description=BETA — /' "$APP_DIR/appConfig.properties"
    rm -f "$APP_DIR/appConfig.properties.bak"
    node -e 'const fs = require("fs"); const f = process.argv[1];
        const c = JSON.parse(fs.readFileSync(f, "utf8")); c.releaseChannel = "beta";
        fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n")' "$APP_DIR/runtime-config.json"
fi

echo "→ Zipping $APP_DIR/..."
zip -rq "$APP_DIR.zip" "$APP_DIR"

if [[ "$SCP_TARGET" == "none" ]]; then
    echo "→ Skipping scp (SCP_TARGET=none)."
else
    echo "→ SCP to $SCP_TARGET ..."
    scp "$APP_DIR.zip" "$SCP_TARGET"
fi

echo ""
echo "✓ Done. Built $(du -h "$APP_DIR.zip" | cut -f1) — $APP_DIR.zip"
echo "  Upload via Administration → Configuration Settings → App Deployment."
