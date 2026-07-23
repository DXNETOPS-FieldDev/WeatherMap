# WeatherMap — Backend Configuration

This doc covers connecting WeatherMap to your Spectrum, AppNeta, and
Data Aggregator backends, and the one-time Content-Security-Policy
change your NetOps Portal needs for the weather/radar/power-outage
overlays. See the main [README](../README.md) for download, install,
top-level configuration, and running the app.

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
2. Navigate: **DX NetOps** → **NetOps Portal** → **Local Override** →
   option **24. Custom HTTP headers to be added to our responses**.
3. Enter headers pipe-separated (`|`), each as `Header-Name: value`.

A validated, working example:

```
Content-Security-Policy: default-src 'self'; script-src 'self' *.ipce.broadcom.com:* 'unsafe-inline' 'unsafe-eval'; connect-src 'self' *.ipce.broadcom.com:* api.rainviewer.com:* https://ornl.opendatasoft.com ws: wss: https://api.openweathermap.org; img-src 'self' data: https://*.tile.openstreetmap.org https://tile.openweathermap.org https://openweathermap.org https://tilecache.rainviewer.com; style-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'self'; font-src 'self'; frame-src 'self';|X-Frame-Options: SAMEORIGIN|X-Content-Type-Options: nosniff|X-XSS-Protection: 1; mode=block|Referrer-Policy: strict-origin|Feature-Policy: 'none'|Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

Notes on this value:
- **No Spectrum entry is needed in `connect-src`.** WeatherMap always
  reaches Spectrum through its same-origin JSP proxy, never directly
  from the browser — same for AppNeta and the Data Aggregator. This is
  confirmed, not just inferred from code: a Spectrum hostname was
  removed from this header on a live deployment, and both device
  alarms and AppNeta Monitoring Point alarms continued to render
  correctly afterward. If an existing portal-wide CSP header has a
  Spectrum entry in it, it's most likely left over from an earlier
  setup or unrelated to WeatherMap, and can be removed.
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

*(Skip this section if you're not using the AppNeta path deep-link — i.e. you
haven't set up `da-proxy.properties`.)*

The Data Aggregator typically sits behind a separate nginx server
block (`dev-netopsda.example.com` in the canonical dev landscape),
which by default only forwards `/odataquery` and `/sso`. Add a
`location /rest/` block so the path-inventory endpoint is reachable:

```nginx
# In the DA-facing nginx server { ... } block:
location /rest/ {
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For  $remote_addr;
    proxy_set_header Host             $host:$server_port;
    proxy_pass https://<DA-internal-host>:8582/rest/;
}
```

Notes:
- Port **8582** is correct in the verified landscape (Broadcom techdocs
  say 8581 — *they're wrong for this PC version*; verify before
  assuming).
- Once added, the URL set in `da.target.url` becomes
  `https://<your-DA-frontend-host>/rest/sdn/networkpath/filtered/`.
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
