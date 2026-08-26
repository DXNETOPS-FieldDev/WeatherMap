# WeatherMap — Backend Configuration

This doc covers connecting WeatherMap to your Spectrum, AppNeta, and
Data Aggregator REST WebServices backends, and the one-time
Content-Security-Policy change your NetOps Portal needs for the
weather/radar/power-outage overlays. (Device inventory and metrics
come from the Data Aggregator automatically, via Performance Center's
own OData API — nothing to configure there; that's a separate,
always-on path from the Data Aggregator REST WebServices covered
below.) See the main [README](../README.md) for download, install,
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

## `spectrum-proxy.properties` — Spectrum backend *(optional)*

Only needed if you have a Spectrum instance and want device/alarm
severity coloring. Without it, WeatherMap still renders devices from
Performance Center — they just show as normal/green. The Spectrum
proxy needs to know where your Spectrum server is and how to
authenticate. **Copy the shipped template and fill it in:**

```bash
cp spectrum-proxy.properties.example spectrum-proxy.properties
# then edit spectrum-proxy.properties — fill in your values
```

| Key | What to set |
|---|---|
| `spectrum.base.url` | Your Spectrum REST URL, e.g. `http://spectrum.example.com:8080/spectrum/` (trailing slash required). Use whatever scheme and port your Spectrum is actually configured for. |
| `spectrum.user` / `spectrum.password` | Spectrum credentials. Browser never sees them. Auto-obfuscated on disk after the first request (see template comments). |
| `spectrum.ssl.verify` | `true` for production with valid certs, `false` for self-signed dev certs |

The default above needs **no reverse proxy at all** — most customers
should just use it as-is. If Performance Center can't reach Spectrum
directly, see [Reverse proxy configuration](#reverse-proxy-configuration).

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

## `da-proxy.properties` — Data Aggregator WebServices *(required if you configure AppNeta)*

Despite the name, this is WeatherMap's own same-origin JSP proxy
(same pattern as `spectrum-proxy.properties` and
`appneta-proxy.properties`) — it's unrelated to any reverse proxy you
run in front of the Data Aggregator itself. If you're looking for
that instead, see [Reverse proxy configuration](#reverse-proxy-configuration)
below.

This is specifically the Data Aggregator's `/rest/` WebServices path —
needed for the **Network Path → PC deep-link** in the AppNeta path
popup, since PC OData doesn't expose AppNeta path inventory. Device
inventory and metrics are a separate, always-on path (the Data
Aggregator via PC's OData API) that needs no configuration at all —
this file is only about the `/rest/` path deep-link. The Data
Aggregator itself is always deployed alongside NetOps Portal, so if
you're already configuring AppNeta there's no reason to skip this.
Same template pattern:

```bash
cp da-proxy.properties.example da-proxy.properties
# then edit da-proxy.properties — fill in your values
```

| Key | What to set |
|---|---|
| `da.target.url` | Full URL of the DA's `/rest/sdn/networkpath/filtered/` endpoint. If Performance Center can reach the Data Aggregator directly, point this straight at it. If not, this goes through a reverse proxy instead — see [Reverse proxy configuration](#reverse-proxy-configuration) below. |
| `da.user` / `da.password` | Same credentials you use to log into NetOps Portal. Browser never sees them. Auto-obfuscated on disk after the first request. |
| `da.ssl.verify` | `true` for production with a valid cert, `false` for self-signed dev certs. |

If this file is missing the path popup just falls back to a plain-text
title — paths still render, links don't.

---

## Changing a `.properties` file later needs a restart

Each proxy JSP (`spectrum-proxy.jsp`, `appneta-proxy.jsp`,
`da-proxy.jsp`) loads its `.properties` file **once per JVM lifetime**
— on the first request it serves — and caches the values in a static
field. Editing the file afterward has no effect until Performance
Center restarts:

```bash
sudo systemctl restart caperfcenter_console
```

(Service name on a stock install; confirm yours with
`systemctl list-units --type=service | grep -i caperfcenter`.)

Configuring a fresh deployment for the first time needs no restart —
nothing has been cached yet. The restart only matters when you're
*correcting* a value that the app has already read. Symptom if you
skip it: the proxy keeps failing against the **old** value, e.g. a
`502 Proxy error: Connection refused` pointing at a host/port you
already fixed on disk.

`runtime-config.json` behaves differently — the browser fetches it on
every page load, so those edits apply on a plain refresh.

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

> ⚠️ **Paste the value only — never the option's label.** The value
> must begin with `Content-Security-Policy:`. Option 24's own title,
> *"Custom HTTP headers to be added to our responses"*, is menu text,
> and it is easy to capture by accident when copying the current
> setting off the screen (or out of a document) to edit it.
>
> If it ends up saved as part of the value, Performance Center emits
> an HTTP header whose **name** is that phrase. Spaces are illegal in
> a header field-name (RFC 7230), so strict clients reject every
> response: `/sso/sign-in.jsp` returns **500**, Portal login fails,
> and SsoConfig itself reports *"Cannot connect to the DX NetOps SSO
> Web Service. Check if DX NetOps is running and retry"* — even
> though SSO is healthy and listening. That error is misleading:
> the service is fine, its own responses are simply unparseable.
>
> **This locks you out of the tool you would fix it with**, since
> SsoConfig talks to that same web service. `SsoProperty.sh` is no
> help either — it needs a REST token from the UI you can no longer
> reach. Recovery then means editing the `Custom.Headers` rows of
> `performance_center_properties` directly (in **both** the
> `netqosportal` and `em` databases), which needs the MySQL
> credential or a `--skip-grant-tables` restart.
>
> To confirm a save went in cleanly, check the response headers:
> ```bash
> curl -sk -D - -o /dev/null http://<portal-host>:8181/pc/ | grep -i 'custom http'
> ```
> Any output at all means the label was captured — expected result is
> nothing.

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

## Reverse proxy configuration

*Most customers don't need this section.* Everything above assumes
Performance Center can reach Spectrum and the Data Aggregator
directly. Skip this unless that's not true in your environment — e.g.
a firewall only allows a shared reverse proxy to reach those hosts.

### Spectrum

If Performance Center can't reach Spectrum directly, add this to your
existing reverse proxy:

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

### Data Aggregator

The Data Aggregator typically sits behind its own nginx server block.
Three `location` blocks matter here, each needed for a different
reason:

- **`/sso`** — the Data Aggregator's own auth handshake back to
  NetOps Portal. Pre-existing DA/Portal plumbing, unrelated to
  WeatherMap.
- **`/odataquery`** — what lets Portal's own OData4 service reach the
  Data Aggregator to serve device/metric data. Also pre-existing,
  unrelated to WeatherMap — but without it, WeatherMap's map is blank
  regardless of anything else being configured correctly.
- **`/rest/`** — the one WeatherMap-specific addition. Needed only if
  you configured `da-proxy.properties` (AppNeta path deep-links).

A full example server block, showing where `/rest/` fits alongside the
other two:

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
- **Port depends on whether your Data Aggregator uses SSL:** `8582`
  when it does, `8581` when it doesn't. Both have been observed in
  working deployments — check yours rather than assuming. A quick way
  to tell, run from the Performance Center host: `curl -sk -o /dev/null
  -w '%{http_code}\n' https://<DA-host>:8582/rest/sdn/networkpath/filtered/`
  and the same against `http://<DA-host>:8581/...`. A `401` is the
  healthy answer (reachable, wants credentials); `000` means wrong
  scheme or port.
- Once `/rest/` is added, the URL set in `da.target.url` becomes
  `https://<DA-frontend-host>/rest/sdn/networkpath/filtered/`.
- Apply with `sudo nginx -t && sudo systemctl reload nginx`.

---

## Known limitations by Performance Center version

**SD-WAN tunnel metrics need the `sdntunnelmfs` navigation property.**
WeatherMap colors tunnel lines by jitter / latency / packet loss,
which it reads by expanding `sdntunnelmfs` on the `sdntunnel` entity.
Not every Performance Center version exposes that property — on one
verified install, `sdntunnel` offered only `groups`, `sdndevice`,
`sdnvirtualinterface`, and `sdnslapaths`.

WeatherMap detects this automatically and degrades instead of failing:
it retries the query without the metrics expansion, so tunnels still
render (uncolored), and shows a banner naming the missing property.
The Sites legend shows the tunnel list with `—` for each metric.

To check your own environment, open this in a browser tab while logged
into the Portal and search for `sdntunnel`:

```
http://<portal-host>:<port>/pc/odata4/api/$metadata
```

If the `<EntityType Name="sdntunnel">` block has no
`NavigationProperty` whose name ends in `mfs`, tunnel metric coloring
won't be available on that version.

**Device CPU / memory / disk depend on those metrics being polled.**
These come from the `cpuandmemorymfs` expansion on the devices query.
Devices that aren't polled for the `im_CPUUtilization`,
`im_MemoryUtilization`, and `im_DiskPercentUsed` families — AppNeta
Monitoring Points and general-purpose endpoints, for example — return
empty values there, and the popup's Metrics tab shows nothing. This is
an inventory/polling condition in Performance Center, not a WeatherMap
setting. Devices still render on the map regardless (position comes
from lat/long, color from alarm severity).

---

## Reference: other files you can tweak

### `appConfig.properties` — portal-facing metadata

```properties
appName=NetOps WeatherMap
description=...
url=index.html?id={ItemIdDA}&startTime={TimeStartUTC}&endTime={TimeEndUTC}
height=700
supportedContext=nc
```

Controls the iframe URL the portal navigates to (`{ItemIdDA}`,
`{TimeStartUTC}`, `{TimeEndUTC}` are substituted at runtime) and the
App View's display name/height in the portal picker.

**Sizing the App View panel:**
- **Height** — set `height` here (pixels). NetOps Portal reads it when
  the widget is *added* to a dashboard and stores it in that
  dashboard's own config, so editing this file later doesn't resize
  widgets that already exist. Remove and re-add the widget to apply a
  new value.
- **Width** — not controllable from here. There's no `width` key (the
  Portal's own bundled App Views don't use one either); the panel
  simply fills whatever dashboard column it sits in. To make it
  narrower, change the dashboard **page layout** to multi-column in
  the Portal UI and place the App View in one of the columns.

### `runtime-config.json` — runtime values

Fetched by the App View at startup. Change a value, save, hard-refresh
the iframe — no build needed.

**Must change before going live:**
- **`triageViewPageId`** — ships set to a specific dev environment's
  Triage View page id, not a placeholder. Your Performance Center
  instance almost certainly uses a different page id. Until this is
  corrected, "Investigate in Triage View" links point to the wrong
  page (or nowhere). Set it to your own environment's Triage View page
  id, or `null` to hide the deep-links entirely. `setup.sh` prompts
  for this along with the backend proxy settings.

**Worth checking before going live:**
- **`owmApiKey`** — ships with a shared testing key. Get your own free
  key at https://openweathermap.org/api so weather features aren't
  subject to someone else's rate limit.
- **`odata.topLimit`** — ships at `500`. If your target group has more
  devices than this, they'll be silently truncated. Check your device
  count and raise this if needed.

| Key | Purpose |
|---|---|
| `owmApiKey` | OpenWeatherMap API key for weather overlays and the popup's Weather tab. *Worth checking before going live — see above.* |
| `mapDefaults.center` / `.zoom` | Initial map view before devices load. Defaults to the continental US. |
| `clusterRadius` | Pixel radius for marker clustering. Lower = clusters break apart sooner as you zoom in. |
| `odata.topLimit` | Maximum devices returned per OData query. *Worth checking before going live — see above.* |
| `odata.resolution` | OData metric aggregation resolution (e.g. `RATE`, `HOUR`). |
| `powerOutages.apiUrl` | ODIN dataset endpoint for power-outage polygons. Defaults to the public ORNL mirror. |
| `powerOutages.maxRecords` | Pagination cap for ODIN. 5000 covers nationwide storms comfortably. |
| `triageViewPageId` | The Performance Center page id for Triage View in **your** environment. **Must change before going live — see above.** Leave `null` to hide the deep-links. |

---

## Troubleshooting

**Portal login fails and SsoConfig says "Cannot connect to the DX
NetOps SSO Web Service" — but the service is running** — the CSP value
was saved with option 24's label prefixed to it, so every response
carries an illegal header name. Confirm with:

```bash
curl -sk -D - -o /dev/null http://<portal-host>:8181/pc/ | grep -i 'custom http'
curl -sk -o /dev/null -w '%{http_code}\n' http://<portal-host>:8381/sso/sign-in.jsp
```

A `Custom HTTP headers to be added to our responses:` line, plus a
**500** from `sign-in.jsp`, confirms it. Note `systemctl status
caperfcenter_sso` shows *active* throughout and `SSOService.log` stays
clean — the service really is fine, so don't chase it. Recovery and
prevention are under
[Portal CSP requirements](#portal-csp-requirements).

**Status banner: "Failed to load runtime-config.json"** — the file is
missing, malformed JSON, or blocked by CSP. Check the browser console.

**Status banner: "No geo-located devices found"** — the group either
has no devices, or none of them have `Latitude` / `Longitude` set in
NetOps.

**No SD-WAN tunnels showing** — the PC OData query returned no tunnels
for the group, or the proxied call failed. Check DevTools → Network
for `/pc/odata4/api/tunnels` and verify the response. If the Sites
legend says "No tunnel data yet", the query succeeded but this group
genuinely has no tunnels between its devices.

**Tunnels render but all gray, no jitter/latency/loss coloring** —
this Performance Center version doesn't expose the tunnel metrics
navigation property. Expected behavior, with a banner explaining it;
see [Known limitations by Performance Center version](#known-limitations-by-performance-center-version).

**Popup Metrics tab empty (no CPU / memory / disk)** — those metrics
aren't being polled for that device. See
[Known limitations by Performance Center version](#known-limitations-by-performance-center-version).

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
(see [Reverse proxy configuration](#reverse-proxy-configuration)),
or the upstream scheme/port in that block is wrong (**8582** for an
SSL Data Aggregator, **8581** for non-SSL). A 500 means
`da-proxy.properties` is
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

**"Investigate in Triage View" link doesn't appear** —
`triageViewPageId` in `runtime-config.json` is null. Set it to the
Triage View page id for your environment.

**Weather overlay tiles don't display** — `https://tile.openweathermap.org`
isn't in CSP `img-src`.

**Weather tab says "Couldn't load weather"** — either the OWM API key
in `runtime-config.json` is bad (rotate it), or the portal's CSP isn't
whitelisting OpenWeatherMap. Check the browser console for a CSP
`connect-src` violation on `https://api.openweathermap.org`.

**Power Outages overlay shows no count or stays empty** — first check
the browser console for a CSP `connect-src` violation on
`ornl.opendatasoft.com`. If CSP is fine, note that ODIN coverage is
voluntary — some utilities (notably FPL in Florida, PG&E in Northern
California) don't participate, so absence of polygons in those areas
may be real, not a bug.

**Gray box instead of a map** — CSP is blocking OSM tiles. Confirm
`https://*.tile.openstreetmap.org` is in the portal's `img-src`.

**Old version showing after redeploy** — the browser caches the
iframe's JS bundle. Hard refresh (Ctrl+Shift+R) or use an incognito
window.
