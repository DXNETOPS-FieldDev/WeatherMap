#!/usr/bin/env bash
#
# Test cases for check-connectivity.sh, for maintainers. Run ON a NetOps Portal server
# that has a configured WeatherMap install (Spectrum, AppNeta, DA and NCM all set up),
# as root so the saved settings are readable, naming your lab's targets:
#
#   sudo SPECTRUM_HOST=spectrum.example.com SPECTRUM_IP=192.0.2.10 \
#        NCM_URL=https://192.0.2.20:8880/ncm-webapp/ PORTAL_HTTP=localhost:9555 \
#        bash connectivity-cases.sh /path/to/check-connectivity.sh
#
#   SPECTRUM_HOST  Spectrum's host name; HTTPS on SPECTRUM_PORT (default 8443), certificate
#                  trusted by the Portal's Java
#   SPECTRUM_IP    the same Spectrum's IP address (its certificate must not name the IP)
#   NCM_URL        an NCM URL with a self-signed / privately issued certificate
#   PORTAL_HTTP    host:port of any plain-HTTP (not TLS) listener reachable from here
#
# Each case feeds answers on stdin and checks the verdict lines. Prints "N of M cases passed".

set -uo pipefail

SCRIPT="${1:?usage: connectivity-cases.sh /path/to/check-connectivity.sh  (see the header for the variables)}"
APP_DIR="${APP_DIR:-/opt/CA/PerformanceCenter/PC/webapps/pc/apps/user/WeatherMap}"
: "${SPECTRUM_HOST:?set SPECTRUM_HOST (see the header)}" "${SPECTRUM_IP:?set SPECTRUM_IP}" \
  "${NCM_URL:?set NCM_URL}" "${PORTAL_HTTP:?set PORTAL_HTTP}"
SPECTRUM_PORT="${SPECTRUM_PORT:-8443}"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK" || exit 1

pass=0; total=0
# run_case <name> <answers> <app-dir> <expected-exit> <pattern>... (all patterns must match the output)
run_case() {
  local name="$1" answers="$2" appdir="$3" want_rc="$4"; shift 4
  total=$((total + 1))
  local out rc ok=1 missing=()
  out=$(printf '%b' "$answers" | bash "$SCRIPT" --app-dir "$appdir" 2>&1); rc=$?
  printf '%s\n' "$out" > "case-$total.out"
  [[ "$rc" == "$want_rc" ]] || { ok=0; missing+=("exit $rc, wanted $want_rc"); }
  local p
  for p in "$@"; do
    grep -q -E -- "$p" <<<"$out" || { ok=0; missing+=("no match: $p"); }
  done
  if (( ok )); then
    pass=$((pass + 1)); echo "PASS  $name"
  else
    echo "FAIL  $name"; printf '        %s\n' "${missing[@]}"
    echo "        --- last 15 lines of output ---"; tail -15 "case-$total.out" | sed 's/^/        /'
  fi
}

NONE=/nonexistent-weathermap
# Answer order per service: use it? / URL (or "use saved URL?") / test login? / ...

# 7. Nothing used: four SKIPPED, nothing contacted, exit 0.
run_case "all services skipped" 'n\nn\nn\nn\nn\n' "$NONE" 0 \
  'Spectrum +SKIPPED' 'AppNeta +SKIPPED' 'Data Aggregator +SKIPPED' 'NCM +SKIPPED' '0 FAIL' 'Not checked: map tiles'

# 2. Name that doesn't resolve.
run_case "DNS failure" "y\nhttps://nosuch-wm-check.invalid:443/spectrum/\nn\nn\nn\nn\nn\n" "$NONE" 1 \
  'Spectrum +FAIL' 'DNS' 'nosuch-wm-check\.invalid'

# 3. Real host, closed port.
run_case "closed port" "y\nhttps://$SPECTRUM_HOST:$((SPECTRUM_PORT + 1))/spectrum/\nn\nn\nn\nn\nn\n" "$NONE" 1 \
  'Spectrum +FAIL' '(refused|timed out)' ":$((SPECTRUM_PORT + 1))"

# 4a. http:// sent to an HTTPS port.
run_case "http to an HTTPS port" "y\nhttp://$SPECTRUM_HOST:$SPECTRUM_PORT/spectrum/\nn\nn\nn\nn\nn\n" "$NONE" 1 \
  'Spectrum +FAIL' 'https://'

# 4b. https:// sent to a plain-HTTP port.
run_case "https to an HTTP port" "n\nn\nn\ny\nhttps://$PORTAL_HTTP/ncm-webapp/\nn\nn\n" "$NONE" 1 \
  'NCM +FAIL' 'not TLS|plain HTTP' 'http://'

# 5. Right server, wrong path.
run_case "wrong path" "y\nhttps://$SPECTRUM_HOST:$SPECTRUM_PORT/nospectrum/\nn\nn\nn\nn\nn\n" "$NONE" 1 \
  'Spectrum +FAIL' '404' 'path'

# 6. Wrong password typed for the login test.
run_case "wrong password" "y\nhttps://$SPECTRUM_HOST:$SPECTRUM_PORT/spectrum/\ny\nwm-check-user\nnot-the-password\nn\nn\nn\nn\n" "$NONE" 1 \
  'Spectrum +FAIL' '(rejected|credentials)'

# 9. Self-signed NCM, typed before install (no saved ssl.verify): WARN with both fixes.
run_case "untrusted certificate, nothing saved" "n\nn\nn\ny\n$NCM_URL\nn\nn\n" "$NONE" 0 \
  'NCM +WARN' 'ncm\.ssl\.verify=false' 'keytool -importcert'

# 10. Certificate doesn't name the address used (Spectrum by IP).
run_case "certificate name mismatch" "y\nhttps://$SPECTRUM_IP:$SPECTRUM_PORT/spectrum/\nn\nn\nn\nn\nn\n" "$NONE" 0 \
  'Spectrum +WARN' '(mismatch|NOT trusted)'

# 11. Direct path fails and the shell's proxy doesn't help either.
https_proxy=http://127.0.0.1:9 run_case "shell proxy tried after a direct failure" \
  "y\nhttps://nosuch-wm-check.invalid:443/spectrum/\nn\nn\nn\nn\nn\n" "$NONE" 1 \
  'Shell proxy variable' 'do NOT use it' "shell's proxy.*not reachable either"

# 12. Only the map/weather/radar/outage services, as before an install (no API key).
run_case "map, weather, radar and outage services" 'n\nn\nn\nn\ny\n' "$NONE" 0 \
  'OpenStreetMap +OK' 'OpenWeatherMap +OK' 'RainViewer +OK' 'ODIN \(outages\) +OK' 'Tile server c' \
  'API key: not tested' 'Radar tiles' "users' browsers load"

# 1. Everything from the saved WeatherMap settings, with login tests.
run_case "saved settings, all OK" 'y\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\n' "$APP_DIR" 0 \
  'Spectrum +OK' 'AppNeta +OK' 'Data Aggregator +OK' 'NCM +OK .*ssl\.verify=false' 'login OK' '0 FAIL' \
  'OpenWeatherMap +OK .*API key accepted' 'appid=<key>'

# 8. No saved secret appears in any output or log file.
total=$((total + 1))
val() { awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,""); print; exit}' "$2" | tr -d '\r'; }
secrets=(); skipped=0
for kv in spectrum:spectrum.password appneta:appneta.token da:da.password ncm:ncm.password; do
  svc="${kv%%:*}"; f="$APP_DIR/$svc-proxy.properties"; [[ -r "$f" ]] || continue
  raw=$(val "${kv#*:}" "$f"); plain="$raw"
  [[ "$raw" == '{obfuscated}'* ]] && plain=$(printf '%s' "${raw#\{obfuscated\}}" | base64 -d)
  # Non-secret text the script legitimately prints: URLs, user names, org id, and its own wording.
  public="$(val "$svc.base.url" "$f") $(val da.target.url "$f") $(val "$svc.user" "$f") $(val appneta.org.id "$f") spectrum appneta ncm"
  for v in "$raw" "$plain"; do
    if [[ ${#v} -lt 4 || "$public" == *"$v"* ]]; then skipped=$((skipped + 1)); else secrets+=("$v"); fi
  done
done
hits=0
for s in "${secrets[@]}"; do
  hits=$((hits + $(cat case-*.out weathermap-connectivity-*.log 2>/dev/null | grep -c -F -- "$s")))
done
logs=$(ls weathermap-connectivity-*.log 2>/dev/null | wc -l)
outs=$(ls case-*.out | wc -l)
if (( ${#secrets[@]} > 0 && logs > 0 && hits == 0 )); then
  pass=$((pass + 1)); echo "PASS  no secrets in output or logs (${#secrets[@]} values checked, $skipped not checkable, in $outs outputs + $logs logs)"
else
  echo "FAIL  secret scan: ${#secrets[@]} values checked, $skipped not checkable, $logs logs, $hits matches"
fi

echo "$pass of $total cases passed"
(( pass == total ))
