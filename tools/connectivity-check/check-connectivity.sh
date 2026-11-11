#!/usr/bin/env bash
#
# WeatherMap connectivity check — run this ON the NetOps Portal server BEFORE installing
# WeatherMap, to confirm the Portal server can reach the services WeatherMap's server-side
# proxies call: Spectrum, AppNeta, the Data Aggregator (DA) and NCM.
#
#   bash check-connectivity.sh            # asks which services you use, then checks each
#   bash check-connectivity.sh --help
#
# For each service you say you use, it checks in order, and stops at the first problem:
#   address → DNS → TCP connection → TLS certificate → HTTP answer → (optional) login
# and says what failed, the likely cause, and what to do about it.
#
# It changes nothing. It only reads, and writes one log file
# (weathermap-connectivity-<host>-<time>.log) in the current folder, which you can
# send to us. Passwords and tokens are never printed or written to the log.
#
# It can also check the services the users' BROWSERS call (OpenStreetMap, OpenWeatherMap,
# RainViewer, ODIN) from this server. That shows whether the network lets the Portal reach
# them; users' workstations need the same access.
#
# Needs: bash 4+, curl, openssl. Optional: the Portal's Java keytool (to check
# certificates against the truststore WeatherMap really uses).

set -uo pipefail

VERSION="1.0.0"
TCP_TIMEOUT=8
HTTP_TIMEOUT=20

usage() {
  cat <<'EOF'
Usage: bash check-connectivity.sh [--app-dir DIR] [--pc-home DIR]

  --app-dir DIR   An installed WeatherMap folder to take saved addresses and credentials
                  from (default: <PC_HOME>/PC/webapps/pc/apps/user/WeatherMap, if present).
  --pc-home DIR   Performance Center install folder (default: $PC_HOME, else
                  /opt/CA/PerformanceCenter).

Run it on the NetOps Portal server, as the user that runs Performance Center (or root),
so it tests the same network path and certificate trust as WeatherMap will.
EOF
}

PC_HOME="${PC_HOME:-/opt/CA/PerformanceCenter}"
APP_DIR=""
while (( $# )); do
  case "$1" in
    --app-dir) APP_DIR="${2:-}"; shift 2 ;;
    --pc-home) PC_HOME="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "$APP_DIR" ]] || APP_DIR="$PC_HOME/PC/webapps/pc/apps/user/WeatherMap"

for tool in curl openssl timeout; do
  command -v "$tool" >/dev/null 2>&1 || { echo "This check needs '$tool', which isn't installed here." >&2; exit 2; }
done

TMPD=$(mktemp -d) || exit 2
chmod 700 "$TMPD"
trap 'rm -rf "$TMPD"' EXIT

HOST_SHORT=$(hostname -s 2>/dev/null || hostname)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$PWD/weathermap-connectivity-$HOST_SHORT-$STAMP.log"
{ : > "$LOG"; } 2>/dev/null || LOG="/tmp/weathermap-connectivity-$HOST_SHORT-$STAMP.log"
: > "$LOG"; chmod 600 "$LOG"

# --- output -------------------------------------------------------------------------

say()  { printf '%s\n' "$*" | tee -a "$LOG"; }
step() { say "    $1"; }                      # one checked layer
why()  { say "      → $1"; }                  # cause / what to do
ask_yn() { # question default(y|n) → status 0 for yes
  local q="$1" def="$2" r hint="[y/N]"
  [[ "$def" == y ]] && hint="[Y/n]"
  read -r -p "$q $hint: " r || r=""
  r="${r:-$def}"
  [[ "$r" =~ ^[Yy] ]]
}
ask() { local r; read -r -p "$1: " r || r=""; printf '%s' "$r"; }
ask_secret() { local r; read -r -s -p "$1: " r || r=""; echo >&2; printf '%s' "$r"; }

# --- helpers ------------------------------------------------------------------------

prop() { # key file → value (empty if absent)
  [[ -r "$2" ]] || return 0
  awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,""); print; exit}' "$2" | tr -d '\r'
}
secret_prop() { # like prop, but undoes the JSPs' {obfuscated} base64 form
  local v; v=$(prop "$1" "$2")
  if [[ "$v" == '{obfuscated}'* ]]; then printf '%s' "${v#\{obfuscated\}}" | base64 -d 2>/dev/null
  else printf '%s' "$v"; fi
}
cfgq() { # escape a value for a double-quoted curl config string
  local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '%s' "$s"
}
urlencode() {
  local LC_ALL=C s="$1" i c out=""
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in [a-zA-Z0-9.~_-]) out+="$c" ;; *) printf -v c '%%%02X' "'$c"; out+="$c" ;; esac
  done
  printf '%s' "$out"
}
is_ip() { [[ "$1" =~ ^[0-9]+(\.[0-9]+){3}$ || "$1" == \[*\] ]]; }

parse_url() { # url → U_SCHEME U_HOST U_PORT U_PATH U_USERINFO; status 1 if not a URL
  local re='^(https?)://([^/@]+@)?(\[[0-9A-Fa-f:]+\]|[^]/:[]+)(:([0-9]+))?(/.*)?$'
  [[ "$1" =~ $re ]] || return 1
  U_SCHEME="${BASH_REMATCH[1]}"; U_USERINFO="${BASH_REMATCH[2]}"; U_HOST="${BASH_REMATCH[3]}"
  U_PORT="${BASH_REMATCH[5]}"; U_PATH="${BASH_REMATCH[6]:-/}"
  [[ -n "$U_PORT" ]] || { [[ "$U_SCHEME" == https ]] && U_PORT=443 || U_PORT=80; }
}
show_url() { printf '%s://%s:%s%s' "$U_SCHEME" "$U_HOST" "$U_PORT" "$U_PATH"; }

# curl request; response kept in $TMPD only. Sets H_CODE H_TYPE H_RC H_ERR.
# Extra curl options come from stdin as a curl config (-K -), so credentials never
# appear in the process list.
http() {
  local w tlsopt=(-k)
  [[ "${HTTP_VERIFY:-0}" == 1 ]] && tlsopt=()
  w=$(curl -sS "${tlsopt[@]}" --noproxy '*' --max-time "$HTTP_TIMEOUT" -K - \
        -o "$TMPD/body" -D "$TMPD/hdr" -w '%{http_code}|%{content_type}' 2>"$TMPD/err")
  H_RC=$?
  H_CODE="${w%%|*}"; H_TYPE="${w#*|}"
  H_ERR=$(tr -d '\r' < "$TMPD/err" | sed 's/^curl: ([0-9]*) //' | head -1)
}
body_has() { grep -q -i -E -- "$1" "$TMPD/body" 2>/dev/null; }
hdr_has()  { grep -q -i -E -- "$1" "$TMPD/hdr" 2>/dev/null; }

curl_cause() { # curl exit code → plain-language cause
  case "$1" in
    6)  echo "the name didn't resolve" ;;
    7)  echo "the connection was refused or couldn't be made" ;;
    28) echo "no answer within ${HTTP_TIMEOUT}s: a firewall dropping traffic, or a very slow service" ;;
    35) echo "the TLS handshake failed" ;;
    52) echo "the server closed the connection without answering (often https:// needed, or a wrong port)" ;;
    56) echo "the connection was reset while reading (often a firewall or proxy cutting it)" ;;
    60) echo "the certificate isn't trusted" ;;
    *)  echo "curl error $1" ;;
  esac
}

# --- environment ----------------------------------------------------------------------

JAVA_HOME_PC=""
for f in "$PC_HOME/PC/conf/wrapper.conf"; do
  [[ -r "$f" ]] && JAVA_HOME_PC=$(awk -F= '/^set\.JAVA_HOME=/{print $2; exit}' "$f" | tr -d '\r')
done
[[ -n "$JAVA_HOME_PC" ]] || { [[ -d /opt/CA/jre ]] && JAVA_HOME_PC=/opt/CA/jre; }

# Java system properties the Portal's JVM is started with (proxy, truststore).
JVM_FLAGS=""
for f in "$PC_HOME/PC/conf/wrapper.conf" "$PC_HOME/PC/conf/wrapper-user.conf"; do
  [[ -r "$f" ]] || continue
  JVM_FLAGS+=$(grep -v '^[[:space:]]*#' "$f" | grep -h -o -E -- \
    '-D(https?\.proxyHost|https?\.proxyPort|https?\.nonProxyHosts|java\.net\.useSystemProxies|javax\.net\.ssl\.trustStore)=[^[:space:]]*' \
    | tr '\n' ' ')
done
jvm_flag() { grep -o -E -- "-D$1=[^ ]*" <<<"$JVM_FLAGS" | head -1 | cut -d= -f2-; }
JVM_PROXY_HOST=$(jvm_flag 'https\.proxyHost'); JVM_PROXY_PORT=$(jvm_flag 'https\.proxyPort')
TRUSTSTORE=$(jvm_flag 'javax\.net\.ssl\.trustStore')
[[ -n "$TRUSTSTORE" ]] || TRUSTSTORE="$JAVA_HOME_PC/lib/security/cacerts"

# PC's Java truststore as PEM, so certificates can be checked against what the JSPs trust.
JAVA_PEM="$TMPD/java-trust.pem"; JAVA_TRUST_COUNT=0
KEYTOOL="$JAVA_HOME_PC/bin/keytool"
if [[ -x "$KEYTOOL" && -r "$TRUSTSTORE" ]]; then
  "$KEYTOOL" -list -rfc -keystore "$TRUSTSTORE" -storepass changeit 2>/dev/null \
    | awk '/-----BEGIN CERTIFICATE-----/{p=1} p{print} /-----END CERTIFICATE-----/{p=0}' > "$JAVA_PEM"
  JAVA_TRUST_COUNT=$(grep -c -- '-----BEGIN CERTIFICATE-----' "$JAVA_PEM")
fi

redact_proxy() { sed -E 's#//[^/@]*@#//<user:password>@#' <<<"$1"; }
ENV_PROXY=""
for v in https_proxy HTTPS_PROXY http_proxy HTTP_PROXY all_proxy ALL_PROXY; do
  [[ -n "${!v:-}" ]] && { ENV_PROXY="${!v}"; break; }
done

say "WeatherMap connectivity check $VERSION"
say "Server: $(hostname -f 2>/dev/null || hostname)   Time (UTC): $STAMP"
say "OS: $( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -sr)   $(curl --version | head -1 | cut -d' ' -f1-2)   $(openssl version)"
if [[ -d "$PC_HOME/PC" ]]; then
  say "Performance Center: $PC_HOME"
else
  say "Performance Center: not found at $PC_HOME. Run this on the NetOps Portal server; results from another"
  say "  machine don't tell you what the Portal can reach."
fi
if (( JAVA_TRUST_COUNT > 0 )); then
  say "Portal Java truststore: $TRUSTSTORE ($JAVA_TRUST_COUNT CA certificates)"
else
  say "Portal Java truststore: couldn't be read ($TRUSTSTORE). Certificates are checked against the OS store only."
fi
if [[ -n "$JVM_PROXY_HOST" ]]; then
  say "Portal Java proxy: https.proxyHost=$JVM_PROXY_HOST https.proxyPort=${JVM_PROXY_PORT:-443}"
  say "  WeatherMap's server-side calls go through this proxy (except nonProxyHosts)."
else
  say "Portal Java proxy: none. WeatherMap's server-side calls connect DIRECTLY to each service."
fi
if [[ -n "$ENV_PROXY" ]]; then
  say "Shell proxy variable: $(redact_proxy "$ENV_PROXY") — note: WeatherMap's server-side calls do NOT use it."
fi
if [[ -d "$APP_DIR" ]]; then
  say "WeatherMap install found: $APP_DIR (saved settings will be offered as defaults)"
fi
say ""

# --- layered checks -------------------------------------------------------------------

V=""; R=""          # verdict and reason of the service being checked
fail() { V=FAIL; R="$1"; }
warn() { [[ "$V" == FAIL ]] || { V=WARN; R="$1"; }; }

check_dns() { # sets IPS (array); status 1 on failure
  IPS=()
  if is_ip "$U_HOST"; then IPS=("${U_HOST//[\[\]]/}"); step "DNS: $U_HOST is an IP address, no lookup needed"; return 0; fi
  mapfile -t IPS < <(getent ahostsv4 "$U_HOST" 2>/dev/null | awk '{print $1}' | awk '!s[$0]++')
  local v6=(); mapfile -t v6 < <(getent ahostsv6 "$U_HOST" 2>/dev/null | awk '{print $1}' | grep ':' | grep -v -i '^::ffff:' | awk '!s[$0]++')
  IPS+=("${v6[@]}")
  if (( ${#IPS[@]} == 0 )); then
    step "DNS: FAILED — '$U_HOST' does not resolve from this server"
    why "check the spelling; if it's right, the Portal server's DNS doesn't know it"
    why "nameservers used: $(awk '/^nameserver/{printf "%s ", $2}' /etc/resolv.conf 2>/dev/null)(an /etc/hosts entry also works)"
    fail "DNS: $U_HOST does not resolve"; return 1
  fi
  step "DNS: $U_HOST → ${IPS[*]}"
}

src_ip() { ip route get "$1" 2>/dev/null | grep -o -E 'src [0-9a-f.:]+' | cut -d' ' -f2; }

check_tcp() { # tries each address; status 1 if none connects
  local ip err rc first="" res
  for ip in "${IPS[@]}"; do
    err=$(timeout "$TCP_TIMEOUT" bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$ip" "$U_PORT" 2>&1); rc=$?
    if (( rc == 0 )); then step "TCP: connected to $ip:$U_PORT"; return 0; fi
    if (( rc == 124 )); then res="timed out after ${TCP_TIMEOUT}s"
    elif [[ "$err" == *refused* ]]; then res="refused"
    elif [[ "$err" == *"No route"* || "$err" == *unreachable* ]]; then res="no route to host"
    else res="failed (${err##*: })"; fi
    step "TCP: $ip:$U_PORT $res"
    [[ -n "$first" ]] || first="$res|$ip"
  done
  res="${first%%|*}"; ip="${first#*|}"
  local from; from=$(src_ip "$ip"); from="${from:-this server}"
  case "$res" in
    refused)
      why "the host answered, but nothing accepts connections on port $U_PORT (wrong port, service down, or a firewall rejecting it)"
      why "check the port in the URL and that the service is running" ;;
    "timed out"*)
      why "no answer at all: usually a firewall silently dropping the traffic"
      why "ask for a firewall rule: $from → $ip port $U_PORT/tcp" ;;
    "no route"*)
      why "this server has no network path to $ip (routing, or a firewall rejecting it)"
      why "ask the network team for a route/rule: $from → $ip port $U_PORT/tcp" ;;
  esac
  fail "TCP to $U_HOST:$U_PORT $res"
  return 1
}

check_tls() { # svc-key saved-verify; WARN on trust problems, FAIL if no TLS at all
  local key="$1" saved_verify="$2" sni=() out
  is_ip "$U_HOST" || sni=(-servername "$U_HOST")
  out=$(timeout 15 openssl s_client -connect "$U_HOST:$U_PORT" "${sni[@]}" -showcerts </dev/null 2>&1)
  if ! grep -q -- '-----BEGIN CERTIFICATE-----' <<<"$out"; then
    if grep -q -i -E 'wrong version number|unknown protocol|packet length too long|record layer failure' <<<"$out"; then
      step "TLS: FAILED — port $U_PORT answers, but not with TLS (it's plain HTTP)"
      why "use http:// instead of https://, or the service's HTTPS port"
      fail "not TLS on port $U_PORT: try http://"
    else
      step "TLS: FAILED — handshake did not complete: $(grep -m1 -i -E 'error|alert|errno' <<<"$out" | cut -c1-140)"
      why "the server refused this client's TLS versions or ciphers, or something in between cut the handshake"
      fail "TLS handshake failed"
    fi
    return 1
  fi
  awk '/-----BEGIN CERTIFICATE-----/{n++; p=1} p{print > (dir "/cert" n ".pem")} /-----END CERTIFICATE-----/{p=0}' \
    dir="$TMPD" <<<"$out"
  cat "$TMPD"/cert*.pem > "$TMPD/chain.pem"
  local leaf="$TMPD/cert1.pem" subj iss end san
  subj=$(openssl x509 -noout -subject -nameopt oneline -in "$leaf" 2>/dev/null | sed 's/^subject= *//')
  iss=$(openssl x509 -noout -issuer -nameopt oneline -in "$leaf" 2>/dev/null | sed 's/^issuer= *//')
  end=$(openssl x509 -noout -enddate -in "$leaf" 2>/dev/null | cut -d= -f2)
  san=$(openssl x509 -noout -ext subjectAltName -in "$leaf" 2>/dev/null | tail -n +2 | tr -d ' ' | cut -c1-160)
  step "TLS: certificate for $subj"
  step "     issued by $iss, valid until $end${san:+, names: $san}"

  local hostopt=(-verify_hostname "$U_HOST"); is_ip "$U_HOST" && hostopt=(-verify_ip "${U_HOST//[\[\]]/}")
  local os_res java_res=""
  os_res=$(openssl verify -untrusted "$TMPD/chain.pem" "${hostopt[@]}" "$leaf" 2>&1 | grep -v ': OK$' | grep -m1 -i error | sed 's/^.*error [0-9]* at [0-9]* depth lookup: *//')
  if (( JAVA_TRUST_COUNT > 0 )); then
    # -partial_chain: like Java, accept a chain that reaches ANY certificate in the truststore,
    # including the server's own certificate imported there (common for NCM's self-issued one).
    java_res=$(openssl verify -partial_chain -no-CApath -no-CAfile -CAfile "$JAVA_PEM" -untrusted "$TMPD/chain.pem" "${hostopt[@]}" "$leaf" 2>&1 \
      | grep -v ': OK$' | grep -m1 -i error | sed 's/^.*error [0-9]* at [0-9]* depth lookup: *//')
  fi
  local trusted_by_java=1
  (( JAVA_TRUST_COUNT > 0 )) && [[ -n "$java_res" ]] && trusted_by_java=0
  (( JAVA_TRUST_COUNT == 0 )) && [[ -n "$os_res" ]] && trusted_by_java=0

  if ! openssl x509 -checkend 0 -noout -in "$leaf" >/dev/null 2>&1; then
    step "TLS: the certificate has EXPIRED"
    why "the service's owner needs to renew it (WeatherMap only accepts it with $key.ssl.verify=false)"
    warn "certificate expired"
  elif ! openssl x509 -checkend 2592000 -noout -in "$leaf" >/dev/null 2>&1; then
    step "TLS: note — the certificate expires within 30 days"
  fi

  if grep -q -i -E 'zscaler|blue ?coat|symantec web|forcepoint|websense|netskope|palo ?alto|fortinet|fortigate|mcafee web|sophos|cisco umbrella|checkpoint|check point|squid' <<<"$iss"; then
    step "TLS: the issuer looks like an intercepting (TLS-inspecting) proxy, not the service itself"
    why "traffic to this service is being inspected; ask for an inspection bypass for $U_HOST, or trust that proxy's CA"
    warn "TLS intercepted by a proxy ($iss)"
  fi

  if (( trusted_by_java )); then
    if (( JAVA_TRUST_COUNT > 0 )); then step "TLS: trusted by the Portal's Java, and the name matches — OK with $key.ssl.verify=true"
    else step "TLS: trusted by the OS store and the name matches (Java truststore not checked)"; fi
  else
    local reason="${java_res:-$os_res}"
    step "TLS: NOT trusted by the Portal's Java: ${reason:-unknown reason}"
    local self=0; [[ "$subj" == "$iss" ]] && self=1
    (( self )) && why "it is self-signed (common for NCM and lab servers)"
    [[ -z "$os_res" && -n "$java_res" ]] && why "the OS trusts it but Java doesn't: its CA is in the OS store, not in $TRUSTSTORE"
    if [[ "$saved_verify" == false ]]; then
      why "your saved setting $key.ssl.verify=false makes WeatherMap accept it anyway"
      R="${R:-certificate not trusted; accepted because $key.ssl.verify=false}"
    elif [[ "$reason" == *mismatch* ]]; then
      why "the certificate is trusted, but it doesn't name '$U_HOST'; it is for: ${san:-$subj}"
      why "use one of those names in the URL (Java checks the name), or set $key.ssl.verify=false when you run setup.sh"
      warn "certificate doesn't match '$U_HOST': use a name it covers, or $key.ssl.verify=false"
    else
      why "with $key.ssl.verify=true (the default) WeatherMap will refuse this server. Either:"
      why "  import the issuing CA into $TRUSTSTORE (keytool -importcert) and restart the Portal, or"
      why "  set $key.ssl.verify=false when you run setup.sh (accepts any certificate from this server)"
      warn "certificate not trusted by the Portal's Java: needs $key.ssl.verify=false or the CA imported"
    fi
  fi
  return 0
}

http_common() { # interpret transport-level problems of the last http(); status 1 if handled as a failure
  if (( H_RC != 0 )); then
    if [[ "$U_SCHEME" == http && ( "$H_RC" == 52 || "$H_RC" == 56 ) ]]; then
      step "HTTP: FAILED — $(curl_cause "$H_RC")"
      why "port $U_PORT probably expects TLS: try https://"
      fail "no HTTP answer on port $U_PORT: try https://"
    else
      step "HTTP: FAILED — $(curl_cause "$H_RC")${H_ERR:+ ($H_ERR)}"
      fail "HTTP request failed: $(curl_cause "$H_RC")"
    fi
    return 1
  fi
  # nginx: "plain HTTP request was sent to HTTPS port"; Tomcat: "...host and port requires TLS."
  if [[ "$H_CODE" == 400 ]] && { body_has 'plain HTTP request|sent to HTTPS port|speaking plain HTTP to an SSL|requires TLS' \
       || { [[ "$U_SCHEME" == http ]] && body_has 'TLS|SSL|HTTPS'; }; }; then
    step "HTTP: FAILED — the server says this port expects HTTPS"
    why "use https:// instead of http://"
    fail "port $U_PORT expects HTTPS: try https://"
    return 1
  fi
  if [[ "$H_CODE" == 404 ]]; then
    step "HTTP: FAILED — 404 Not Found at $U_PATH"
    why "the server is reachable, but the path is wrong: $1"
    fail "HTTP 404: wrong path (expected $1)"
    return 1
  fi
  if [[ "$H_CODE" =~ ^5 ]]; then
    step "HTTP: the server answered with an error ($H_CODE)"
    return 0
  fi
  return 0
}

# --- per-service probes ---------------------------------------------------------------
# Each probe: identify (no credentials), then optional login. Base URLs end with "/".

probe_spectrum() {
  http < <(printf 'url = "%s"\n' "$(cfgq "${BASE}restful/landscapes")")
  http_common "the Spectrum URL ends in /spectrum/, e.g. https://host:8443/spectrum/" || return
  if [[ "$H_CODE" == 401 ]] || { [[ "$H_CODE" == 200 ]] && body_has 'spectrum'; }; then
    step "HTTP: Spectrum's REST API answered (HTTP $H_CODE, asks for a login)"
  else
    step "HTTP: unexpected answer (HTTP $H_CODE, $H_TYPE): this may not be Spectrum's /spectrum/ URL"
    warn "unexpected HTTP $H_CODE: is this the Spectrum URL?"; return
  fi
  [[ -n "$LOGIN_USER" ]] || return
  http < <(printf 'url = "%s"\nuser = "%s:%s"\n' "$(cfgq "${BASE}restful/landscapes")" "$(cfgq "$LOGIN_USER")" "$(cfgq "$LOGIN_PASS")")
  if [[ "$H_CODE" == 200 ]] && body_has '<landscape'; then step "Login: OK — Spectrum accepted the account"; LOGIN_OK=1
  elif [[ "$H_CODE" == 401 || "$H_CODE" == 403 ]] || body_has 'Log In'; then
    step "Login: FAILED — Spectrum rejected the account, HTTP $H_CODE"
    why "check the user name and password; the account needs OneClick web access"
    fail "Spectrum rejected the credentials"
  else step "Login: unexpected answer (HTTP $H_CODE, $H_TYPE)"; warn "login gave unexpected HTTP $H_CODE"; fi
}

probe_appneta() {
  http < <(printf 'url = "%s"\n' "$(cfgq "${BASE}v3/organization")")
  http_common "the AppNeta URL ends in /api/, e.g. https://<tenant>.pm.appneta.com/api/" || return
  if [[ "$H_CODE" == 401 || "$H_CODE" == 403 ]]; then
    step "HTTP: AppNeta's API answered (HTTP $H_CODE, asks for a token)"
  elif [[ "$H_CODE" == 200 && "$H_TYPE" == *html* ]]; then
    step "HTTP: got a web page, not the API: the URL should end in /api/"
    fail "got a web page, not AppNeta's API: URL should end in /api/"; return
  else
    step "HTTP: unexpected answer (HTTP $H_CODE, $H_TYPE)"; warn "unexpected HTTP $H_CODE: is this the AppNeta API URL?"; return
  fi
  [[ -n "$LOGIN_PASS" ]] || return
  http < <(printf 'url = "%s"\nheader = "Authorization: Token %s"\n' "$(cfgq "${BASE}v3/organization")" "$(cfgq "$LOGIN_PASS")")
  if [[ "$H_CODE" == 200 ]] && body_has '"id"'; then
    if [[ -n "$LOGIN_USER" ]] && ! body_has "\"id\":[[:space:]]*$LOGIN_USER[,}]"; then
      local ids; ids=$(grep -o -E '"id":[[:space:]]*[0-9]+' "$TMPD/body" | grep -o -E '[0-9]+' | head -8 | tr '\n' ' ')
      step "Login: the token works, but organization $LOGIN_USER isn't one it can see (it sees: ${ids:-none})"
      why "check appneta.org.id"
      warn "token OK, but org id $LOGIN_USER not visible to it"
    else
      step "Login: OK — AppNeta accepted the token${LOGIN_USER:+ (organization $LOGIN_USER visible)}"; LOGIN_OK=1
    fi
  elif [[ "$H_CODE" == 401 || "$H_CODE" == 403 ]]; then
    step "Login: FAILED — AppNeta rejected the token (HTTP $H_CODE)"
    why "the token is wrong, expired or revoked: create a new API token in AppNeta"
    fail "AppNeta rejected the token"
  else step "Login: unexpected answer (HTTP $H_CODE, $H_TYPE)"; warn "login gave unexpected HTTP $H_CODE"; fi
}

DA_FILTER='<?xml version="1.0" encoding="UTF-8"?><FilterSelect xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="filter.xsd"><Filter><Or><SDNAppNetaAttrs.PathId type="EQUAL">0</SDNAppNetaAttrs.PathId></Or></Filter><Select use="exclude" isa="exclude"><Item use="include"/></Select></FilterSelect>'

probe_da() {
  http < <(printf 'url = "%s"\n' "$(cfgq "$TARGET")")
  http_common "WeatherMap calls https://<da-host>:<port>/rest/sdn/networkpath/filtered/" || return
  if [[ "$H_CODE" == 401 ]] && hdr_has 'realm="OpenAPI"'; then
    step "HTTP: the Data Aggregator answered (HTTP 401, asks for a login)"
  elif [[ "$H_CODE" == 401 || "$H_CODE" == 405 || "$H_CODE" == 200 ]]; then
    step "HTTP: the server answered (HTTP $H_CODE)"
  else
    step "HTTP: unexpected answer (HTTP $H_CODE, $H_TYPE)"; warn "unexpected HTTP $H_CODE: is this the Data Aggregator?"; return
  fi
  [[ -n "$LOGIN_USER" ]] || return
  http < <(printf 'url = "%s"\nuser = "%s:%s"\nrequest = "POST"\n' "$(cfgq "$TARGET")" "$(cfgq "$LOGIN_USER")" "$(cfgq "$LOGIN_PASS")"
    printf 'header = "Content-Type: application/xml"\nheader = "Accept: application/xml"\ndata = "%s"\n' "$(cfgq "$DA_FILTER")")
  if [[ "$H_CODE" == 200 ]]; then step "Login: OK — the Data Aggregator accepted the account and the network-path query"; LOGIN_OK=1
  elif [[ "$H_CODE" == 401 || "$H_CODE" == 403 ]]; then
    step "Login: FAILED — the Data Aggregator rejected the account, HTTP $H_CODE"
    why "use a NetOps Portal account (the DA uses the Portal's logins)"
    fail "DA rejected the credentials"
  else
    step "Login: accepted, but the network-path query returned HTTP $H_CODE"
    why "$(grep -o -E '<LocalizedMessage>[^<]*' "$TMPD/body" | head -1 | sed 's/<LocalizedMessage>//' | cut -c1-160)"
    warn "DA query returned HTTP $H_CODE"
  fi
}

probe_ncm() {
  http < <(printf 'url = "%s"\nrequest = "POST"\nheader = "Accept: application/json"\ndata = "username=&password="\n' \
    "$(cfgq "${BASE}rest/api/v1/auth/token")")
  http_common "the NCM URL ends in /ncm-webapp/, e.g. https://ncm-host:8880/ncm-webapp/" || return
  if body_has 'Failed to authenticate|REST-Generic'; then
    step "HTTP: NCM's REST API answered (HTTP $H_CODE, asks for a login)"
  else
    step "HTTP: unexpected answer (HTTP $H_CODE, $H_TYPE): this may not be NCM's /ncm-webapp/ URL"
    warn "unexpected HTTP $H_CODE: is this the NCM URL?"; return
  fi
  [[ -n "$LOGIN_USER" ]] || return
  http < <(printf 'url = "%s"\nrequest = "POST"\nheader = "Accept: application/json"\ndata = "username=%s&password=%s"\n' \
    "$(cfgq "${BASE}rest/api/v1/auth/token")" "$(urlencode "$LOGIN_USER")" "$(urlencode "$LOGIN_PASS")")
  if [[ "$H_CODE" == 200 ]] && body_has '"access_token"'; then step "Login: OK — NCM accepted the account"; LOGIN_OK=1
  elif [[ "$H_CODE" == 401 || "$H_CODE" == 403 ]] || body_has 'Failed to authenticate'; then
    step "Login: FAILED — NCM rejected the account, HTTP $H_CODE"
    why "check the user name and password of the NCM account"
    fail "NCM rejected the credentials"
  else step "Login: unexpected answer (HTTP $H_CODE, $H_TYPE)"; warn "login gave unexpected HTTP $H_CODE"; fi
  : > "$TMPD/body"   # don't keep the token on disk
}

# --- one service ----------------------------------------------------------------------

NAMES=(); VERDICTS=(); TARGETS=(); REASONS=()
record() { NAMES+=("$1"); VERDICTS+=("$2"); TARGETS+=("$3"); REASONS+=("$4"); }

# check_service <name> <key> <default-use y|n> <url-label> <secret-key> <user-key|org-key>
check_service() {
  local name="$1" key="$2" def="$3" label="$4" skey="$5" ukey="$6"
  local pfile="$APP_DIR/$key-proxy.properties" urlkey="$key.base.url"
  [[ "$key" == da ]] && urlkey="da.target.url"
  say "== $name"
  if ! ask_yn "Does this Portal use $name with WeatherMap?" "$def"; then
    say "    skipped (not used)"; say ""; record "$name" SKIPPED "-" "not used"; return
  fi

  local url="" saved_url saved_verify
  saved_url=$(prop "$urlkey" "$pfile"); saved_verify=$(prop "$key.ssl.verify" "$pfile")
  if [[ -e "$pfile" && ! -r "$pfile" ]]; then
    say "    (saved settings in $pfile exist but aren't readable by $(id -un); run with sudo to use them)"
  fi
  if [[ -n "$saved_url" ]] && ask_yn "  Use the saved address $saved_url?" y; then url="$saved_url"
  else url=$(ask "  $label"); saved_verify=""; fi
  url="${url#"${url%%[![:space:]]*}"}"; url="${url%"${url##*[![:space:]]}"}"

  LOGIN_USER=""; LOGIN_PASS=""; LOGIN_OK=0
  if ask_yn "  Also test the login?" n; then
    local s_user s_pass
    s_user=$(prop "$ukey" "$pfile"); s_pass=$(secret_prop "$skey" "$pfile")
    if [[ -n "$s_pass" && -n "$saved_url" && "$url" == "$saved_url" ]] && ask_yn "  Use the credentials saved in $(basename "$pfile")?" y; then
      LOGIN_USER="$s_user"; LOGIN_PASS="$s_pass"
    elif [[ "$key" == appneta ]]; then
      LOGIN_USER=$(ask "  AppNeta organization id (optional)"); LOGIN_PASS=$(ask_secret "  AppNeta API token")
    else
      LOGIN_USER=$(ask "  User name"); LOGIN_PASS=$(ask_secret "  Password")
    fi
    [[ -n "$LOGIN_PASS" ]] || { LOGIN_USER=""; say "    (no password/token given: login not tested)"; }
    unset s_pass
  fi

  V=OK; R=""
  if ! parse_url "$url"; then
    say "    Address: '$url' is not a URL (expected http(s)://host[:port]/path)"
    say ""; record "$name" FAIL "${url:-<empty>}" "not a valid URL"; return
  fi
  local shown; shown=$(show_url)
  say "    Address: $shown"
  if [[ -n "$U_USERINFO" ]]; then
    why "the URL contains a user name/password; WeatherMap takes credentials separately — remove them from the URL"
    say ""; record "$name" FAIL "$shown" "credentials embedded in the URL"; return
  fi
  [[ "$U_PATH" == */ ]] || { [[ "$key" == da ]] || U_PATH="$U_PATH/"; }
  BASE="$U_SCHEME://$U_HOST:$U_PORT$U_PATH"
  if [[ "$key" == da ]]; then
    TARGET="$BASE"
    [[ "$U_PATH" == "/" ]] && TARGET="${BASE}rest/sdn/networkpath/filtered/"
  fi

  if [[ -n "$JVM_PROXY_HOST" ]]; then
    step "Note: the Portal's Java uses proxy $JVM_PROXY_HOST:${JVM_PROXY_PORT:-443}; this check tests the direct path."
    why "if this service is only reachable through that proxy, a direct failure below is expected"
  fi

  if check_dns && check_tcp; then
    if [[ "$U_SCHEME" == https ]]; then
      check_tls "$key" "$saved_verify" && "probe_$key"
    else
      step "TLS: none (plain http:// — credentials cross the network unencrypted)"
      "probe_$key"
    fi
  fi

  # Direct path failed: would the shell's proxy have worked? (WeatherMap won't use it.)
  if [[ "$V" == FAIL && -n "$ENV_PROXY" && ( "$R" == DNS* || "$R" == TCP* ) ]]; then
    local code
    code=$(printf 'url = "%s"\nproxy = "%s"\n' "$(cfgq "$BASE")" "$(cfgq "$ENV_PROXY")" \
      | curl -sS -k --max-time "$HTTP_TIMEOUT" -K - -o /dev/null -w '%{http_code}' 2>/dev/null)
    if [[ -n "$code" && "$code" != 000 ]]; then
      step "Via the shell's proxy ($(redact_proxy "$ENV_PROXY")): reachable (HTTP $code)"
      why "this service is reachable only through that proxy, but WeatherMap's server-side calls don't use it"
      why "ask for a direct firewall rule, or configure the Portal's Java proxy (-Dhttps.proxyHost/-Dhttps.proxyPort in wrapper.conf; affects the whole Portal)"
      R="$R; reachable only via the shell proxy, which WeatherMap doesn't use"
    else
      step "Via the shell's proxy ($(redact_proxy "$ENV_PROXY")): not reachable either"
    fi
  fi

  (( LOGIN_OK )) && [[ "$V" == OK ]] && R="reachable, login OK${R:+; $R}"
  [[ "$V" == OK && -z "$R" ]] && R="reachable"
  unset LOGIN_PASS
  say ""
  record "$name" "$V" "$U_HOST:$U_PORT" "$R"
}

check_service "Spectrum"        spectrum n "Spectrum URL (e.g. https://spectrum-host:8443/spectrum/)"            spectrum.password spectrum.user
check_service "AppNeta"         appneta  n "AppNeta API URL (e.g. https://<tenant>.pm.appneta.com/api/)"           appneta.token     appneta.org.id
check_service "Data Aggregator" da       y "Data Aggregator URL (e.g. https://da-host:8582/)"                       da.password       da.user
check_service "NCM"             ncm      n "NCM URL, as this server reaches it (e.g. https://ncm-host:8880/ncm-webapp/)" ncm.password ncm.user

# --- map, weather, radar and outage services -----------------------------------------
# In WeatherMap the users' BROWSERS load these, not the Portal server. Checking them from here
# shows whether this network lets the Portal reach them; users' workstations need the same.

UA="WeatherMap-connectivity-check/$VERSION"
RC="$APP_DIR/runtime-config.json"
OWM_KEY=$(grep -o -E '"owmApiKey"[[:space:]]*:[[:space:]]*"[^"]*"' "$RC" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)"$/\1/')
ODIN_URL=$(grep -o -E '"apiUrl"[[:space:]]*:[[:space:]]*"https?://[^"]*"' "$RC" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)"$/\1/')
ODIN_URL="${ODIN_URL:-https://ornl.opendatasoft.com/api/explore/v2.1/catalog/datasets/odin-real-time-outages-county}"

# web_url <label> <url> <ok-codes regex> <content-type regex> [shown-url]; status 1 on failure
web_url() {
  local label="$1" url="$2" codes="$3" tre="$4" shown="${5:-$2}"
  parse_url "$url" || { step "$label: bad URL"; fail "bad URL"; return 1; }
  step "$label: $shown"
  check_dns || return 1
  check_tcp || return 1
  HTTP_VERIFY=1 http < <(printf 'url = "%s"\nuser-agent = "%s"\n' "$(cfgq "$url")" "$(cfgq "$UA")")
  if [[ "$H_RC" == 60 || "$H_RC" == 35 || "$H_RC" == 51 ]]; then
    local iss
    iss=$(timeout 15 openssl s_client -connect "$U_HOST:$U_PORT" -servername "$U_HOST" </dev/null 2>/dev/null \
      | openssl x509 -noout -issuer -nameopt oneline 2>/dev/null | sed 's/^issuer= *//')
    step "HTTPS: this server doesn't trust the certificate it was given (issuer: ${iss:-unknown})"
    why "if that issuer is your web proxy or firewall, the traffic is being TLS-inspected; browsers then need"
    why "that proxy's CA (usually pushed to workstations already) — or ask for an inspection bypass for $U_HOST"
    warn "certificate not trusted here (issuer: ${iss:-unknown}): TLS inspection?"
    return 0
  fi
  if (( H_RC != 0 )); then
    step "HTTPS: FAILED — $(curl_cause "$H_RC")${H_ERR:+ ($H_ERR)}"
    fail "$(curl_cause "$H_RC")"; return 1
  fi
  if [[ "$H_CODE" =~ ^($codes)$ && "$H_TYPE" =~ $tre ]]; then
    step "HTTPS: $H_CODE ($H_TYPE)"
    return 0
  fi
  if [[ "$H_TYPE" == *html* ]]; then
    step "HTTPS: got a web page (HTTP $H_CODE) instead of $tre — often a proxy's block or login page"
    why "check whether your web proxy or firewall filters $U_HOST"
    fail "got a web page (HTTP $H_CODE), not the service: blocked by a proxy?"
  else
    step "HTTPS: unexpected answer (HTTP $H_CODE, $H_TYPE)"
    warn "unexpected HTTP $H_CODE from $U_HOST"
  fi
  return 1
}

# web_service <name> <first-url>; runs the service's checks (web_<key>) and the proxy fallback
web_service() {
  local name="$1" key="$2" first="$3"
  say "== $name"
  V=OK; R=""
  "web_$key"
  if [[ "$V" == FAIL && -n "$ENV_PROXY" && ( "$R" == DNS* || "$R" == TCP* ) ]]; then
    local code
    code=$(printf 'url = "%s"\nproxy = "%s"\nuser-agent = "%s"\n' "$(cfgq "$first")" "$(cfgq "$ENV_PROXY")" "$(cfgq "$UA")" \
      | curl -sS --max-time "$HTTP_TIMEOUT" -K - -o /dev/null -w '%{http_code}' 2>/dev/null)
    if [[ -n "$code" && "$code" != 000 ]]; then
      step "Via the shell's proxy ($(redact_proxy "$ENV_PROXY")): reachable (HTTP $code)"
      why "users' browsers likely reach it the same way (through the proxy), which is fine for WeatherMap"
      R="$R; reachable via the shell proxy"
    else
      step "Via the shell's proxy ($(redact_proxy "$ENV_PROXY")): not reachable either"
    fi
  fi
  [[ "$V" == OK && -z "$R" ]] && R="reachable"
  say ""
  parse_url "$first" >/dev/null 2>&1
  record "$name" "$V" "$U_HOST:$U_PORT" "$R"
}

web_osm() {
  local s
  for s in a b c; do   # WeatherMap spreads tile requests over a/b/c.tile.openstreetmap.org
    web_url "Tile server $s" "https://$s.tile.openstreetmap.org/0/0/0.png" '200' 'image/' || return
  done
}
web_owm() {
  local q="" shown_q=""
  [[ -n "$OWM_KEY" ]] && { q="?appid=$OWM_KEY"; shown_q="?appid=<key>"; }
  web_url "Weather tiles" "https://tile.openweathermap.org/map/precipitation_new/0/0/0.png$q" '200|401' 'image/' \
    "https://tile.openweathermap.org/map/precipitation_new/0/0/0.png$shown_q" || return
  web_url "Current conditions" "https://api.openweathermap.org/data/2.5/weather?lat=0&lon=0${q:+&appid=$OWM_KEY}" '200|401' 'json' \
    "https://api.openweathermap.org/data/2.5/weather?lat=0&lon=0${q:+&appid=<key>}" || return
  if [[ -z "$OWM_KEY" ]]; then
    step "API key: not tested (no WeatherMap install here); HTTP 401 'Invalid API key' still proves the path is open"
  elif [[ "$H_CODE" == 401 ]]; then
    step "API key: REJECTED — OpenWeatherMap refused the owmApiKey in $RC"
    why "the key is invalid or blocked; weather overlays will stay empty until it is replaced"
    warn "OpenWeatherMap rejected WeatherMap's API key"
  else
    step "API key: accepted (owmApiKey from $RC)"
    R="reachable, API key accepted"
  fi
}
web_rainviewer() {
  web_url "Radar frame list" "https://api.rainviewer.com/public/weather-maps.json" '200' 'json' || return
  local host path
  host=$(grep -o -E '"host":"[^"]*"' "$TMPD/body" | head -1 | cut -d'"' -f4)
  path=$(grep -o -E '"path":"[^"]*"' "$TMPD/body" | tail -1 | cut -d'"' -f4)
  if [[ -z "$path" ]]; then
    step "Radar tiles: the frame list had no frames, so no tile could be tried"
    warn "RainViewer returned no radar frames"; return
  fi
  web_url "Radar tiles" "${host:-https://tilecache.rainviewer.com}$path/256/0/0/0/2/1_1.png" '200' 'image/'
}
web_odin() {
  web_url "Outage records" "$ODIN_URL/records?limit=1" '200' 'json'
}

say "== Map, weather, radar and power-outage services"
if ask_yn "Also check OpenStreetMap, OpenWeatherMap, RainViewer and ODIN from this server?" y; then
  say "    (In WeatherMap the users' browsers load these. This shows whether the network lets the Portal reach"
  say "     them; users' workstations, and the Portal's Content-Security-Policy if set, need the same access.)"
  say ""
  WEB_CHECKED=1
  web_service "OpenStreetMap"  osm        "https://a.tile.openstreetmap.org/0/0/0.png"
  web_service "OpenWeatherMap" owm        "https://tile.openweathermap.org/map/precipitation_new/0/0/0.png"
  web_service "RainViewer"     rainviewer "https://api.rainviewer.com/public/weather-maps.json"
  web_service "ODIN (outages)" odin       "$ODIN_URL/records?limit=1"
else
  WEB_CHECKED=0
  say "    skipped"; say ""
fi

# --- summary --------------------------------------------------------------------------

say "== Summary"
say "$(printf '%-16s %-8s %-40s %s' SERVICE RESULT TARGET DETAIL)"
nok=0; nwarn=0; nfail=0; nskip=0
for i in "${!NAMES[@]}"; do
  say "$(printf '%-16s %-8s %-40s %s' "${NAMES[$i]}" "${VERDICTS[$i]}" "${TARGETS[$i]}" "${REASONS[$i]}")"
  case "${VERDICTS[$i]}" in OK) ((nok++)) ;; WARN) ((nwarn++)) ;; FAIL) ((nfail++)) ;; SKIPPED) ((nskip++)) ;; esac
done
say ""
say "Result: $nok OK, $nwarn WARN, $nfail FAIL, $nskip SKIPPED (of ${#NAMES[@]} services)"
if (( WEB_CHECKED )); then
  say "Map, weather, radar and outage services were checked from this server. Users' browsers load them in"
  say "WeatherMap, so users' workstations need the same access."
else
  say "Not checked: map tiles, weather, radar and power outages (users' browsers load those directly)."
fi
say "Log: $LOG"
(( nfail == 0 ))
