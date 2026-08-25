# WeatherMap — Backend Configuration

This doc covers connecting WeatherMap to your Spectrum, AppNeta, and
Data Aggregator backends, and the one-time Content-Security-Policy
change your NetOps Portal needs for the weather/radar/power-outage
overlays. See the main [README](../README.md) for download, install,
top-level configuration, and running the app.

## Recommended: run `setup.sh` instead of editing files by hand

The deployed App View folder includes `setup.sh` — an interactive
script (plain bash, no Node/npm needed) that prompts for each backend's
connection details and writes the `.properties` files for you:

```bash
cd <PC_HOME>/PC/webapps/pc/apps/user/WeatherMap
./setup.sh
```

It covers everything below (Spectrum, AppNeta, the Data Aggregator, and
the Triage View page id) in one guided pass, and is safe to re-run —
it asks before overwriting a file that's already configured. The
sections below describe what the script does under the hood, and are
still the reference if you'd rather edit a file directly (e.g. to
change one value later without re-running the whole flow).

---

## `spectrum-proxy.properties` — Spectrum backend

Required. The Spectrum proxy needs to know where your Spectrum server
is and how to authenticate. **Copy the shipped template and fill it
in:**

```bash
cp spectrum-proxy.properties.example spectrum-proxy.properties
# then edit spectrum-proxy.properties — fill in your values
```

| Key | What to set |
|---|---|
| `spectrum.base.url` | Your Spectrum REST URL, e.g. `https://spectrum.example.com:8443/spectrum/` (trailing slash required) |
| `spectrum.user` / `spectrum.password` | Spectrum credentials. Browser never sees them. Auto-obfuscated on disk after the first request (see template comments). |
| `spectrum.ssl.verify` | `true` for production with valid certs, `false` for self-signed dev certs |

### Spectrum via reverse proxy (optional alternative)

The default above (`spectrum-proxy.properties` + the shipped
`spectrum-proxy.jsp`) needs **no reverse proxy at all** — most
customers should just use it as-is. This alternative is only for the
minority who already run their own nginx (or equivalent) in front of
NetOps Portal and would rather route the Spectrum connection through
that instead of the shipped JSP.

If that's you: add a location block like this to your existing
reverse proxy:

```nginx
location /spectrum/ {
    proxy_pass https://<spectrum-host>:8443/spectrum/;
    proxy_set_header Authorization "Basic <base64 user:pass>";
    proxy_ssl_verify off;
}
```

Then in `appConfig.properties`, comment out the default `url=` line
and uncomment the `&proxy=nginx` one (both are already present in the
file, with matching comments):

```properties
# Option A — JSP Proxy (default)
#url=index.html?id={ItemIdDA}&startTime={TimeStartUTC}&endTime={TimeEndUTC}

# Option B — nginx reverse proxy
url=index.html?id={ItemIdDA}&startTime={TimeStartUTC}&endTime={TimeEndUTC}&proxy=nginx
```

With this option, `spectrum-proxy.properties` isn't used at all — the
credentials live in your reverse proxy's own config instead.

---

## `appneta-proxy.properties` — AppNeta backend *(optional)*

Only needed if you want the AppNeta Monitoring Points feature. Same
pattern as the Spectrum proxy:

```bash
cp appneta-proxy.properties.example appneta-proxy.properties
# then edit appneta-proxy.properties — fill in your values
```

| Key | What to set |
|---|---|
| `appneta.base.url` | Your AppNeta tenant REST URL, e.g. `https://demo.pm.appneta.com/api/` (trailing slash required) |
| `appneta.org.id` | Numeric AppNeta org id. Injected server-side so the App View can't query other orgs. Get this from your AppNeta tenant admin. |
| `appneta.token` | AppNeta API token. Generate in AppNeta UI under user profile → API Access Tokens. Browser never sees it. Auto-obfuscated on disk after first request. |
| `appneta.ssl.verify` | `true` for public AppNeta tenants. Only flip to `false` for on-prem AppNeta with a self-signed cert. |

---

## `da-proxy.properties` — Data Aggregator WebServices *(optional, paired with AppNeta)*

Despite the name, this is WeatherMap's own same-origin JSP proxy
(same pattern as `spectrum-proxy.properties` and
`appneta-proxy.properties`) — it's unrelated to any reverse proxy you
run in front of the Data Aggregator itself. If you're looking for
that instead, see [Data Aggregator REST endpoint](#data-aggregator-rest-endpoint)
below.

Only needed if you want the **Network Path → PC deep-link** in the
AppNeta path popup. PC OData doesn't expose AppNeta path inventory,
so we look it up via the Data Aggregator's REST WebServices. Same
template pattern:

```bash
cp da-proxy.properties.example da-proxy.properties
# then edit da-proxy.properties — fill in your values
```

| Key | What to set |
|---|---|
| `da.target.url` | Full URL of the DA's `/rest/sdn/networkpath/filtered/` endpoint, reached through your DA-facing nginx (e.g. `https://dev-netopsda.example.com/rest/sdn/networkpath/filtered/`). Direct calls to the internal DA host are typically unreachable from PC's servlet container — go through the public nginx. **Requires an `/rest/` `location` block on the DA-facing nginx** — see [Data Aggregator REST endpoint](#data-aggregator-rest-endpoint) below. |
| `da.user` / `da.password` | Same credentials you use to log into NetOps Portal. Browser never sees them. Auto-obfuscated on disk after the first request. |
| `da.ssl.verify` | `true` for production with a valid cert, `false` for self-signed dev certs. |

If this file is missing the path popup just falls back to a plain-text
title — paths still render, links don't.

Changes to any `.properties` file require the servlet container to
recompile the JSP (typically a Tomcat / Jetty restart).

---

## Portal CSP requirements

NetOps Portal sets a strict Content Security Policy on App View
responses that by default blocks the external image / fetch origins
WeatherMap relies on. Configure it via the **SSO Configuration Tool
(SsoConfig)**, which sets the header directly on NetOps Portal itself:

1. On the Performance Center host, run `./SsoConfig` from
   `<installation_directory>/PerformanceCenter`.
2. Navigate: **DX NetOps** → **NetOps Portal** → **Remote Value** →
   option **24. Custom HTTP headers to be added to our responses**.
3. Paste the value below into that field, substituting your own
   Spectrum / AppNeta / Data Aggregator hostnames where applicable.

```
Content-Security-Policy: default-src 'self'; script-src 'self' *.ipce.broadcom.com:* 'unsafe-inline' 'unsafe-eval'; connect-src 'self' *.ipce.broadcom.com:* api.rainviewer.com:* https://ornl.opendatasoft.com ws: wss: https://api.openweathermap.org; img-src 'self' data: https://*.tile.openstreetmap.org https://tile.openweathermap.org https://openweathermap.org https://tilecache.rainviewer.com; style-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'self'; font-src 'self'; frame-src 'self';|X-Frame-Options: SAMEORIGIN|X-Content-Type-Options: nosniff|X-XSS-Protection: 1; mode=block|Referrer-Policy: strict-origin|Feature-Policy: 'none'|Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

Notes on this value:
- **`X-Frame-Options`, `X-Content-Type-Options`, `X-XSS-Protection`,
  `Referrer-Policy`, `Feature-Policy`, `Strict-Transport-Security`**
  are general portal security hardening, unrelated to WeatherMap.
  Include or drop them based on your own security posture.
- **`Feature-Policy: 'none'`** is deprecated syntax (superseded by
  `Permissions-Policy`) and isn't valid as a bare `'none'` value on its
  own — likely inert as written. Reproduced here because it's what's
  actually deployed, not because it's a recommended pattern.
- Whether saving this setting requires a NetOps Portal restart to take
  effect isn't documented — verify in your own environment.

### Origins WeatherMap needs

| Origin | CSP directive | Why |
|---|---|---|
| `https://*.tile.openstreetmap.org` | img-src | OSM base map tiles |
| `https://tile.openweathermap.org` | img-src | Weather overlay tiles |
| `https://openweathermap.org` | img-src | Weather condition icons in the popup |
| `https://api.openweathermap.org` | connect-src | Current-conditions API |
| `api.rainviewer.com` | connect-src | RainViewer available-timestamps API |
| `https://tilecache.rainviewer.com` | img-src | RainViewer radar tile images |
| `https://ornl.opendatasoft.com` | connect-src | ODIN power-outage API |

The Spectrum, AppNeta, and Data Aggregator APIs don't need CSP entries
— they're proxied same-origin through the shipped JSPs.

---

## Data Aggregator REST endpoint

*(Skip this section if you haven't configured `da-proxy.properties`
— used for the AppNeta path deep-link.)*

If NetOps Portal already runs behind a reverse proxy, the Data
Aggregator typically sits behind a separate nginx server block that,
by default, already forwards `/odataquery` and `/sso` — pre-existing
DA/Portal plumbing, unrelated to WeatherMap or AppNeta. (If there's no
reverse proxy in the picture at all, neither of those applies either —
skip this whole section.) The only thing WeatherMap needs is one new
`location /rest/` block added alongside them, so the path-inventory
endpoint is reachable. Shown below as a full server block so you can
see where the new block fits — `/odataquery` and `/sso` are included
for context only, not because WeatherMap needs them:

```nginx
server {
    listen       443 ssl http2;
    listen       [::]:443 ssl http2;
    server_name  <DA-frontend-host>;
    root         /usr/share/nginx/html;
    ssl_certificate "/etc/nginx/certs/fullchain.pem";
    ssl_certificate_key "/etc/nginx/certs/privkey.pem";

    location /odataquery {
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Host    $host:$server_port;
        proxy_pass https://<DA-internal-host>:8582/odataquery;
    }
    location /sso {
        proxy_set_header X-Forwarded-host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Host    $host:$server_port;
        proxy_pass  https://<PC-internal-host>:8382/sso;
    }
    # In order to reach /rest/sdn/networkpath in DA
    location /rest/ {
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Host    $host:$server_port;
        proxy_pass https://<DA-internal-host>:8582/rest/;
    }
}
```

Notes:
- **Only the `/rest/` block is new.** `/odataquery` and `/sso` are
  already there (assuming Portal already runs behind a reverse proxy)
  for other DA/Portal functions that have nothing to do with
  WeatherMap or AppNeta.
- Port **8582** is the Data Aggregator's port in a verified working
  deployment (Broadcom techdocs say 8581 for this endpoint — *that's
  wrong for this PC version*; verify against your own environment
  before assuming).
- Once added, the URL set in `da.target.url` becomes
  `https://<DA-frontend-host>/rest/sdn/networkpath/filtered/`.
- Apply with `sudo nginx -t && sudo systemctl reload nginx`.

---

## Troubleshooting

**All markers green / no alarms in popup** — the Spectrum proxy failed.
Open DevTools → Network, look for `spectrum-proxy.jsp`, check the
response. `502 Proxy error` means the JSP reached the backend but
couldn't talk to Spectrum — verify `spectrum-proxy.properties`. `500
Proxy misconfigured` means the JSP couldn't load its properties file.

**No AppNeta MPs / paths showing** — open DevTools → Network, look for
`appneta-proxy.jsp`. A 500 usually means `appneta-proxy.properties` is
missing or has a bad token. A 200 with empty results means the
configured org id has no MPs visible to the token's user.

**Path titles don't link to PC** — the DA proxy isn't responding.
DevTools → Network, look for `da-proxy.jsp`. A 502 usually means the
DA-facing nginx hasn't been configured with a `location /rest/` block
(see [Data Aggregator REST endpoint](#data-aggregator-rest-endpoint)),
or the upstream port in that block is wrong (verified port is **8582**,
not 8581 as some docs say). A 500 means `da-proxy.properties` is
missing or unreadable. A 200 with an empty `<NetworkPathList/>` means
the DA found no matching paths for the AppNeta path IDs sent.

If nginx and the DA backend both check out but `da-proxy.jsp` still
502s, verify name resolution **from the Performance Center host
itself** — not from your reverse proxy, not from your own machine.
`da.target.url`'s hostname has to resolve and be reachable from
wherever the JSP actually executes; a host being reachable from
elsewhere on the network doesn't guarantee the PC server can reach it
too (DNS zone visibility, `/etc/hosts` entries, and firewall rules can
all differ per host). A quick `curl` of `da.target.url` run directly
on the PC host is the fastest way to confirm.

**Weather overlay tiles don't display** — `https://tile.openweathermap.org`
isn't in CSP `img-src`.

**Weather tab says "Couldn't load weather" (CSP cause)** — if the OWM
API key in `runtime-config.json` is confirmed good, check that
`https://api.openweathermap.org` is in CSP `connect-src`.

**Power Outages overlay empty (CSP cause)** — if the browser console
shows a CSP `connect-src` violation for `ornl.opendatasoft.com`, the
CSP whitelist hasn't been updated for ODIN.

**Gray box instead of a map** — CSP is blocking OSM tiles. Confirm
`https://*.tile.openstreetmap.org` is in the portal's `img-src`.
