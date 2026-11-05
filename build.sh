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
# CHANNEL=<name> builds a separate App View, "NetOps WeatherMap (<Name>)", into
# WeatherMap<Name>/ and WeatherMap<Name>.zip instead (for example CHANNEL=beta or
# CHANNEL=thresholds). It installs NEXT TO the stable one rather than over it
# (App Deployment keys apps by their folder), with its own runtime-config.json
# and its own credential files. The name is lower-case letters and digits.
#     CHANNEL=beta SCP_TARGET=none ./build.sh


set -euo pipefail

CHANNEL="${CHANNEL:-stable}"
if [[ ! "$CHANNEL" =~ ^[a-z][a-z0-9]*$ ]]; then
    echo "Error: CHANNEL must be lower-case letters and digits, starting with a letter (got '$CHANNEL')." >&2
    exit 1
fi
if [[ "$CHANNEL" == "stable" ]]; then
    APP_DIR=WeatherMap
else
    LABEL="$(printf '%s' "${CHANNEL:0:1}" | tr '[:lower:]' '[:upper:]')${CHANNEL:1}"   # beta -> Beta
    TAG="$(printf '%s' "$CHANNEL" | tr '[:lower:]' '[:upper:]')"                        # beta -> BETA
    APP_DIR="WeatherMap$LABEL"
fi

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

if [[ "$CHANNEL" != "stable" ]]; then
    # A distinct name in the App View dropdown, and a tag in the map's status
    # banner (runtime-config "releaseChannel"), so the two can't be mistaken
    # for each other. channels/<name>.json, when present, sets that variant's
    # defaults: each top-level key in it replaces the same key in
    # runtime-config.json (for example "alarms" and "metrics" for thresholds).
    echo "→ Marking the package as the $LABEL App View..."
    sed -i.bak -e "s/^appName=.*/appName=NetOps WeatherMap ($LABEL)/" \
        -e "s/^description=/description=$TAG — /" "$APP_DIR/appConfig.properties"
    rm -f "$APP_DIR/appConfig.properties.bak"
    node -e 'const fs = require("fs"); const [f, channel, preset] = process.argv.slice(1);
        const c = JSON.parse(fs.readFileSync(f, "utf8")); c.releaseChannel = channel;
        if (fs.existsSync(preset)) Object.assign(c, JSON.parse(fs.readFileSync(preset, "utf8")));
        fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n")' \
        "$APP_DIR/runtime-config.json" "$CHANNEL" "channels/$CHANNEL.json"
    if [[ -f "channels/$CHANNEL.json" ]]; then echo "  (defaults from channels/$CHANNEL.json)"; fi
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
