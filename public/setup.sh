#!/usr/bin/env bash
#
# Interactive setup for WeatherMap's backend connections. Run this ON the
# server, from inside the deployed App View folder (where this script and
# appConfig.properties live), after unzipping WeatherMap.zip:
#
#   cd <PC_HOME>/PC/webapps/pc/apps/user/WeatherMap
#   ./setup.sh
#
# Prompts for Spectrum (optional), AppNeta (optional), the Data
# Aggregator (asked whenever AppNeta is configured — it's always
# deployed alongside NetOps Portal, so there's no reason to skip it),
# and the Triage View page id, then writes the real .properties files
# and updates runtime-config.json. No Node/npm needed —
# this is plain bash, since most customer environments won't have a
# JS build toolchain installed.
#
# Safe to re-run: skips any file that already exists unless you confirm
# you want to reconfigure it.

set -euo pipefail

if [[ ! -f "appConfig.properties" ]]; then
  echo "Error: appConfig.properties not found in $(pwd)." >&2
  echo "Run this script from inside the deployed WeatherMap folder." >&2
  exit 1
fi

# --- helpers -----------------------------------------------------------

# Escape a value for safe use as a sed replacement (delimiter is |).
sed_escape() {
  printf '%s' "$1" | sed -e 's/[\&|]/\\&/g'
}

ask() {
  local prompt="$1" default="${2:-}"
  local reply
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " reply
    echo "${reply:-$default}"
  else
    read -r -p "$prompt: " reply
    echo "$reply"
  fi
}

ask_secret() {
  local prompt="$1"
  local reply
  read -r -s -p "$prompt: " reply
  echo "" >&2
  echo "$reply"
}

ask_yn() {
  local prompt="$1" default="${2:-N}"
  local reply
  read -r -p "$prompt [$default]: " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

# write_properties <example-file> <real-file> <key=value> [<key=value> ...]
write_properties() {
  local example="$1" real="$2"
  shift 2
  if [[ -f "$real" ]]; then
    if ! ask_yn "$real already exists — reconfigure and overwrite it?" "N"; then
      echo "  Skipping $real."
      return 0
    fi
  fi
  cp "$example" "$real"
  local pair key value
  for pair in "$@"; do
    key="${pair%%=*}"
    value="${pair#*=}"
    sed -i.bak "s|^${key}=.*|${key}=$(sed_escape "$value")|" "$real"
  done
  rm -f "${real}.bak"
  echo "  Wrote $real."
}

echo "=== WeatherMap backend setup ==="
echo ""

# --- Spectrum (optional) ------------------------------------------------

if ask_yn "Configure Spectrum (device/alarm severity coloring)?" "Y"; then
  echo "--- Spectrum ---"
  spectrum_url=$(ask "Spectrum REST base URL (e.g. https://spectrum.example.com:8443/spectrum/)")
  spectrum_user=$(ask "Spectrum username")
  spectrum_password=$(ask_secret "Spectrum password")
  spectrum_verify="false"
  if ask_yn "Verify Spectrum's TLS certificate? (say no for self-signed dev certs)" "N"; then
    spectrum_verify="true"
  fi
  write_properties spectrum-proxy.properties.example spectrum-proxy.properties \
    "spectrum.base.url=$spectrum_url" \
    "spectrum.user=$spectrum_user" \
    "spectrum.password=$spectrum_password" \
    "spectrum.ssl.verify=$spectrum_verify"
  echo ""
fi

# --- AppNeta (optional) --------------------------------------------------

configured_appneta=false
if ask_yn "Configure AppNeta Monitoring Points?" "N"; then
  echo "--- AppNeta ---"
  appneta_url=$(ask "AppNeta REST base URL (e.g. https://your-tenant.pm.appneta.com/api/)")
  appneta_org=$(ask "AppNeta organization id (numeric orgId)")
  appneta_token=$(ask_secret "AppNeta API token")
  appneta_verify="true"
  if ask_yn "Verify AppNeta's TLS certificate? (say no only for on-prem AppNeta with a self-signed cert)" "Y"; then
    appneta_verify="true"
  else
    appneta_verify="false"
  fi
  write_properties appneta-proxy.properties.example appneta-proxy.properties \
    "appneta.base.url=$appneta_url" \
    "appneta.org.id=$appneta_org" \
    "appneta.token=$appneta_token" \
    "appneta.ssl.verify=$appneta_verify"
  configured_appneta=true
  echo ""
fi

# --- Data Aggregator (required if AppNeta is configured) ----------------

if [[ "$configured_appneta" == true ]]; then
  echo "--- Data Aggregator (for AppNeta path -> PC deep-links) ---"
  da_url=$(ask "DA REST URL (e.g. https://your-da-host/rest/sdn/networkpath/filtered/)")
  da_user=$(ask "NetOps Portal username (DA uses the same login)")
  da_password=$(ask_secret "NetOps Portal password")
  da_verify="false"
  if ask_yn "Verify the DA's TLS certificate? (say no for self-signed dev certs)" "N"; then
    da_verify="true"
  fi
  write_properties da-proxy.properties.example da-proxy.properties \
    "da.target.url=$da_url" \
    "da.user=$da_user" \
    "da.password=$da_password" \
    "da.ssl.verify=$da_verify"
  echo ""
fi

# --- runtime-config.json: Triage View page id (required) ----------------

echo "--- Triage View deep-link (required for the 'Investigate in Triage View' links) ---"
echo "Find this by opening Triage View in your Portal and checking the page id in the URL."
triage_id=$(ask "Triage View page id (leave blank to hide the deep-links)")
if [[ -n "$triage_id" ]]; then
  cp runtime-config.json runtime-config.json.bak
  sed -i.bak2 "s|\"triageViewPageId\":[^,}]*|\"triageViewPageId\": ${triage_id}|" runtime-config.json
  rm -f runtime-config.json.bak runtime-config.json.bak2
  echo "  Updated runtime-config.json."
else
  cp runtime-config.json runtime-config.json.bak
  sed -i.bak2 "s|\"triageViewPageId\":[^,}]*|\"triageViewPageId\": null|" runtime-config.json
  rm -f runtime-config.json.bak runtime-config.json.bak2
  echo "  Set triageViewPageId to null (deep-links hidden)."
fi
echo ""

echo "=== Done ==="
echo "No servlet-container restart needed — both the .properties files and"
echo "runtime-config.json are read fresh on the next request/page load."
