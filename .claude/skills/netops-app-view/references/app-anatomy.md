# App View Anatomy

An OpenAPI App View is a self-contained web app that NetOps Portal embeds via iframe on dashboards and context pages. This file covers the folder layout, the `appConfig.properties` schema, deployment, and the constraints all App Views must respect.

## Folder layout (deployable shape)

The folder zipped and uploaded to the portal must contain, at minimum:

```
<app-name>/
├── appConfig.properties     ← required; defines the app to the portal
├── index.html               ← entry point loaded in the iframe
├── assets/                  ← bundled JS, CSS, fonts, images (conventional)
│   ├── index-<hash>.js
│   └── index-<hash>.css
└── sample-data.json         ← optional; static data for debug mode
```

Additional files (images, additional JS modules, license files for bundled libraries) live alongside `index.html`. The zip's top-level entry must be the app folder itself, not the contents of the folder.

The maximum ZIP file size is 100 MB.

## appConfig.properties schema

The portal reads this file to register the app. Format is one `key=value` per line.

```
appName=<App Name>
description=<Optional description shown in the App View picker>
url=<Required URL with optional placeholders>
height=<height in pixels>
supportedContext=<one or more context codes, comma-separated>
```

Fields in detail:

- **appName** (required) — Unique name. This is what the user picks in the App View settings dropdown.
- **description** (optional) — Shown in the App View when the app is selected.
- **url** (required) — The path the iframe loads, with optional placeholders the portal substitutes. Typically `index.html?<params>`. Placeholders are documented in `url-parameters.md`.
- **height** (optional) — iframe pixel height. Default 250. Most useful apps run 500–900.
- **supportedContext** (optional) — Which NetOps Portal pages the app can appear on. Comma-separated codes:
  - `d` — Device
  - `i` — Interface (app available only on interface context pages, not at the dashboard level)
  - `s` — Server
  - `r` — Router
  - `g` — Group
  - `nc` — None — app appears in all contexts (this is the default)

### Example

```
appName=Percentile Trend App
description=This is a Percentile Trend App
url=index.html?id={ItemIdDA}&startTime={TimeStartUTC}&endTime={TimeEndUTC}&metric=im_UtilizationIn
height=750
supportedContext=i,d
```

### Real example (from a working app)

```
appName=BNPP Flow Data
description=IBMCloud Flow Data for BNPP devices
url=index.html?id={ItemIdDA}&startTime={TimeStartUTC}&endTime={TimeEndUTC}&limit=100&itemName={itemName}
height=900
supportedContext=d,s
```

## Deployment

1. Zip the app folder (the folder, not its contents).
2. In NetOps Portal: hover **Administration** → **Configuration Settings** → click **App Deployment**.
3. In the App field, browse and select the ZIP file, then click **Add**.
4. The app is copied to the user app directory. A NetOps Portal restart is not required.
5. To display: edit a dashboard or page → add an App View → in view settings, select the app from the dropdown and save.

If the app does not appear in the dropdown after upload, something in `appConfig.properties` is incorrect.

To support multiple instances on one page, add two App Views to the same dashboard and select the same app in both. The app must work correctly in both iframes simultaneously.

## Constraints (non-negotiable)

These are from the PDF "App Development Best Practices" section and are the most common breakage sources:

1. **Relative paths only.** Never embed full URLs (`http://hostname:8181/...`). Use `/pc/odata4/api/...` or `/pc/odata/api/...`. Full URLs break behind firewalls or on DNS changes.

2. **No NetOps Portal JS, CSS, or images.** The portal isolates apps in iframes precisely so it can evolve its own assets without breaking apps. Depending on portal assets defeats this and breaks the app on portal updates.

3. **Internally-sourced libraries only.** Bundle every JS/CSS library into the app folder. Don't load from CDNs. Include any license files the library requires.

4. **iframe-safe.** The app runs in an iframe. Don't use `window.top`, `target='_top'`, or anything that breaks iframe isolation. Both Browser View and App View use iframes; verify the app works inside one before deploying.

5. **Multi-instance safe.** Avoid hardcoded DOM IDs that would collide if two copies of the app ran on the same dashboard. Avoid global `window` pollution. Each iframe has its own document, so React's `#root` convention is fine.

6. **Debug mode.** Include an optional URL parameter (`?debug=1` is the convention) that switches the app from the live OData call to a canned `sample-data.json`. This is essential for development without portal access and for downstream maintainers.

7. **Sanitize before sharing.** If the app will be shared, the sample data must contain no real device names, IPs, or other identifying info.

8. **Data aggregator IDs.** The OpenAPI uses data aggregator item IDs (the `ItemIdDA` placeholder gives you this). It does **not** recognize NetOps Portal IDs. If you only have a portal ID, use the `datasources` web service to convert.

## OpenAPI access

To access OpenAPI data, the request must come from an app on the NetOps Portal host. The deployment step places the app folder on the NetOps Portal host, which is why direct OData queries from arbitrary external clients won't work but the deployed app's queries will.

The portal proxies the request: a browser call to `/pc/odata4/api/devices` is forwarded to the data aggregator at `http://<da_host>:8581/odata4/api/devices`. Apps should always use the `/pc/...` path; the portal handles authentication via the user's session.

## Limitations to mention to users

- PDF and CSV printing and emailing options are not available from App Views (they are from native portal views).
- The OpenAPI's role is targeted extraction, not bulk export. For bulk data, the docs recommend the Data Extraction utilities, not the API.

## Content Security Policy (the surprise that bites every new App View)

NetOps Portal sets a strict Content Security Policy on responses for `/pc/apps/user/*` paths (where deployed App Views live). The default policy looks like this:

```
default-src 'self';
script-src 'self' *.ipce.broadcom.com:* 'unsafe-inline' 'unsafe-eval';
connect-src 'self' *.ipce.broadcom.com:* ws: wss:;
img-src 'self' data:;
style-src 'self' 'unsafe-inline';
base-uri 'self';
frame-ancestors 'self';
font-src 'self';
frame-src 'self';
```

The directives that matter for App View development:

- **`img-src 'self' data:`** — `<img>` tags may load only from the portal's own origin or from inline `data:` URIs. **Any external image source — tile servers, CDN-hosted icons, weather radar overlays — is blocked.**
- **`connect-src 'self' ws: wss:`** — `fetch()` and `XMLHttpRequest` may only go to the portal's own origin (plus the Broadcom whitelist). **Any external API call is blocked**, including OpenWeatherMap, Google APIs, geocoding services, etc.
- **`script-src` and `style-src`** already include `'unsafe-inline'` and `'unsafe-eval'`, so bundled Vite/Webpack output works fine.

### What this means in practice

Before you commit to using an external service in an App View, check whether its requests would violate the CSP. Common gotchas:

- **Map tile servers** (OSM, CartoDB, Mapbox, ArcGIS, OpenWeatherMap tiles) — blocked by `img-src`.
- **External REST APIs** (weather APIs, geocoding, currency conversion) — blocked by `connect-src`.
- **CDN-hosted images, fonts, or scripts** — blocked by `img-src`, `font-src`, `script-src` respectively.

Anything bundled by Vite into the app folder is served from `'self'` and works without issue. The CSP only affects requests to external origins.

### Finding where the CSP is set

The first time you encounter a CSP error, resist the urge to grep config files. The fastest path is:

1. **Confirm the CSP value on the wire.** In the browser DevTools → Network tab, find the request for the App View's `index.html` (path: `/pc/apps/user/<app-name>/index.html`). Click it → Response Headers → find `Content-Security-Policy`. That tells you exactly what the browser is enforcing, regardless of which config file set it.

2. **Eliminate suspects with curl.** Request the same URL with and without going through the reverse proxy. The portal often requires an authenticated session for App View paths, so grab `JSESSIONID` from DevTools → Application → Cookies first:

   ```bash
   # Through the reverse proxy (what the browser sees)
   curl -kI 'https://<portal-host>/pc/apps/user/<app-name>/index.html' \
     -H 'Cookie: JSESSIONID=<value>'

   # Direct to the backend (bypassing the proxy)
   curl -kI 'https://<backend-host>:<port>/pc/apps/user/<app-name>/index.html' \
     -H 'Cookie: JSESSIONID=<value>'
   ```

   Interpret:
   - CSP present on both → the portal backend is setting it (likely a servlet filter inside the deployed webapp)
   - CSP present on the proxy response only → the reverse proxy is adding it
   - CSP value differs between the two → both layers are setting it, and the proxy is overriding (or appending)

3. **Only after that, grep config files** if you need to find the exact source of the policy text:
   ```bash
   grep -rn "Content-Security-Policy" /opt/CA/PerformanceCenter/ 2>/dev/null
   grep -rn "img-src 'self' data:" /etc/nginx/ 2>/dev/null
   ```

   Note that Jetty rewrite-rules files in NetOps Portal (`jetty-rewrite-rules.xml`) typically exempt `/pc/` paths via a `^(?!/pc/).*` regex — so they're usually *not* the source of the CSP on App View responses, even though they're a tempting first place to look.

### Overriding the CSP at nginx

When the portal backend sets the CSP via a servlet filter, modifying that filter is risky — it's shared code that's likely updated by Broadcom on portal upgrades. The clean fix is to override the header at the reverse-proxy layer, scoped narrowly to App View paths only:

```nginx
server {
    listen 443 ssl http2;
    server_name <portal-host>;
    # ... ssl config ...

    # CSP override for App View paths — MUST come before the generic /pc block.
    location ~ ^/pc/apps/user/ {
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Host $host:$server_port;
        proxy_pass https://<backend-host>:443;

        proxy_hide_header Content-Security-Policy;
        add_header Content-Security-Policy "<extended CSP value here>" always;
    }

    # All other portal paths — original CSP from backend passes through unchanged.
    location /pc {
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Host $host:$server_port;
        proxy_pass https://<backend-host>:443/pc;
    }
}
```

Four details that matter:

- **Regex vs prefix matching.** `location ~ ^/pc/apps/user/` is a regex form, evaluated before prefix-matched `location /pc` blocks regardless of file order. Without the regex form, the generic `/pc` block would match first and the override would never fire.

- **Why `proxy_pass` has no trailing path.** With a regex location, nginx doesn't strip the matched prefix. So `proxy_pass https://<backend>:443;` (no trailing path) passes the full URI through unchanged. Adding `/pc` would double up.

- **`proxy_hide_header` + `add_header` together.** Without `proxy_hide_header`, the backend's CSP would *also* be sent. Browsers enforce multiple CSP headers intersectively — the result would be more restrictive than either alone. Hide the backend's, emit your own.

- **The `always` flag on `add_header`.** Without it, the header only applies to 2xx/3xx responses. With it, the CSP is set on error responses too, which is what you want for consistency.

The blast radius of this change is intentionally narrow: only requests matching `^/pc/apps/user/` get the relaxed CSP, so the rest of the portal keeps its existing security headers exactly as before.

### Extending the CSP additively

Don't replace the policy wholesale — extend it. Take the original value (from the DevTools inspection in step 1 above), find the directive that needs more origins, and add only those origins. Leave everything else identical.

Example. The default `img-src` is:

```
img-src 'self' data:;
```

To allow OSM tiles, extend just that directive:

```
img-src 'self' data: https://*.tile.openstreetmap.org;
```

For an app that uses OSM plus OpenWeatherMap (tiles, popup icons, and the JSON API):

```
img-src 'self' data: https://*.tile.openstreetmap.org https://tile.openweathermap.org https://openweathermap.org;
connect-src 'self' *.ipce.broadcom.com:* ws: wss: https://api.openweathermap.org;
```

Preserve every existing token. If the default already lists `*.ipce.broadcom.com:*` (a Broadcom whitelist for internal infrastructure), keep it — removing it can break unrelated portal features.

### Verification

After applying changes with `sudo nginx -t && sudo systemctl reload nginx`:

1. **Hard-refresh** the dashboard (Ctrl+Shift+R) or open in an incognito window. Browsers aggressively cache iframe content and CSP-blocked requests; without a hard refresh you may see the old behavior.
2. **Re-inspect the CSP** in DevTools → Network → response headers. Confirm your additions are present and the directives you didn't touch are unchanged.
3. **Watch the console** for any remaining CSP errors. Each one names the directive that blocked it ("violates ... 'img-src'", etc.), pointing at exactly what still needs to be added.

### Common pitfalls

- **Stale bundle after rebuild.** Vite hashes filenames on each build (`index-<hash>.js`), so a successful redeploy should produce different filenames in the deployed `/pc/apps/user/<app>/assets/` directory. If you see the same hash as before, the upload silently failed.
- **CSP errors persisting after the nginx reload.** Almost always browser caching of the iframe. Try an incognito window.
- **Tiles load but `fetch()` calls don't, or vice versa.** Different directives. Tiles are `img-src`, fetches are `connect-src`. The CSP error message names which directive blocked the request.
- **A successful deploy with the wrong app name.** The portal's App Deployment page silently overwrites existing apps with the same `appName`. If you renamed the app in `appConfig.properties` and uploaded, the old app is still there at its old name and the new one is a separate entry.

### Telling the user about this upfront

When scaffolding a new App View that uses any external resource, list those origins in the README so the portal admin knows what to whitelist before the app will work. Include the directive and the origin, like:

> This app requires the portal's CSP to whitelist:
> - `connect-src`: `https://api.example.com`
> - `img-src`: `https://cdn.example.com`

This turns a "why doesn't this work?" debugging session into a one-step ops task.
