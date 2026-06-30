# NetOps WeatherMap — App View for DX NetOps Portal

A geographic, single-pane operations view that puts your network **on the
map** — devices, SD-WAN tunnels, AppNeta paths, alarms, weather, and
power-grid events all in one place — so operators can spot what's going
wrong, *where*, in the first second of looking.

![NetOps WeatherMap](docs/weathermap-screenshot.png)

> This guide covers downloading, installing, configuring, and running
> WeatherMap from a pre-built release. Building it from source has its
> own guide (coming soon).

---

## Why operators love it

Network outages don't happen in spreadsheets — they happen in physical places.
A circuit slows down because there's a thunderstorm sitting on top of the
branch. Sites in a metro go dark because a utility cut power for
maintenance. A tunnel between two POPs starts dropping packets after a
provider change. **WeatherMap puts all of that in one view**, so the
operator's first reaction is *"oh, that's why"* instead of *"let me pull
up another tool."*

---

## Features

### See what's down — and where

- **One pin per device, colored by alarm severity.** Critical sites pop
  red the moment DX NetOps sees the event; Major/Minor/Initial roll up
  the same way. No alarm list to scan — the map *is* the alarm list.
- **Marker clustering** at low zoom rolls nearby sites into a bubble
  that inherits the worst severity inside it, so a single red dot at
  continent-scale tells you which region is hurting.
- **Auto-fits to your sites on load** — open the dashboard, see your
  network. No pan-and-zoom dance.

### Understand *why* it's down

- **Live weather overlays** — precipitation, temperature, wind, cloud
  cover — togglable from the layers control. When a branch link
  degrades, you'll see if there's a storm sitting on it.
- **Animated radar playback** — scrub or auto-play the last hour of
  precipitation across your footprint to correlate link events with
  weather fronts moving through.
- **Power-grid outage overlay** — utility-reported outage polygons from
  the public ODIN feed. Click a polygon to see the utility, county,
  meters affected, cause (storm vs scheduled vs equipment), and ETR.
  When a whole metro of devices goes red, this often answers it before
  you've even opened a ticket.

### Single-click drill-down

- **Four-tab device popup** — *Site Info* (name, IP, location,
  power-grid status), *Weather* (live conditions at the site), *Metrics*
  (CPU / Memory / Disk over the dashboard's time window), *Alarms*
  (full active alarm list from DX NetOps Spectrum). All without leaving the map.
- **Deep-link straight to NetOps Triage View** — a topology icon next
  to the device name and an "Investigate in Triage View →" link inside
  the Alarms tab take operators one click from *"the map shows red"* to
  the full per-device drill-down in Performance Center.
- **Click-through from MPs and paths into PC** — AppNeta Monitoring
  Point names link straight to their PC inventory page, and Network
  Path titles link to the per-path detail view in PC. Operators jump
  from *"this path looks bad"* to the full drill-down without leaving
  the map.

### Visualize your SD-WAN, not just your devices

- **SD-WAN tunnel overlay** — every DX NetOps managed SD-WAN
  tunnel between branches drawn on the map as a line between the two
  device pins, **colored by jitter / latency / packet loss** so you can
  see at a glance where the WAN overlay is healthy and where it's
  hurting.
- **Sites legend** with per-device visibility toggles — show only the
  branches you're triaging, hide the rest of the mesh.

### Active synthetic measurements with AppNeta

- **AppNeta Monitoring Points** rendered as bullseye markers right
  alongside your managed devices, with the targets they probe (other
  MPs, ISPs, SaaS endpoints) drawn as globe icons.
- **Per-path lines** colored by jitter, latency, loss, and MOS — the
  same color language as the SD-WAN tunnels, so synthetic-path
  degradation and overlay degradation read the same way at a glance.
- **MP filter** in the legend for narrowing long path lists down to the
  ones you care about.
- **Path popup with PC metadata** — clicking a path line shows the
  geographic route (e.g. `"Miami, FL ↔ Seattle, WA"`), the date PC
  first saw the path, and the live latency / loss / jitter / MOS — both
  the AppNeta-measured metrics and PC's own path inventory in one place.

### Operator-friendly controls

- **Env / Network split layer control** — environmental overlays
  (weather, radar, power outages) and network overlays (SD-WAN tunnels,
  AppNeta paths) toggle independently. You can stack just the layers
  relevant to the question you're asking.
- **Filterable legends** — both the SD-WAN sites legend and the AppNeta
  MPs legend have a search box. Useful when you have hundreds of
  branches or paths and only care about a subset.
- **Plays nicely with NetOps group context** — drop the App View into
  any group-level dashboard and it scopes automatically to the devices
  in that group, respecting whatever group hierarchy your organization
  uses.

---

## Prerequisites

- **One of:**
  - Administrator role on your NetOps Portal account (for [Method A](#method-a--upload-via-portal-ui)), or
  - SSH + sudo access to the portal server (for [Method B](#method-b--direct-deploy-via-ssh))
- Ability to get your portal's reverse-proxy CSP updated (typically nginx)
  — see [Backend Configuration](docs/BACKEND_CONFIGURATION.md)
- *(Optional)* An AppNeta tenant + API token, if you want the AppNeta
  Monitoring Points feature

---

## Download

Download the latest `WeatherMap.zip` from this repository's Releases
page. (Building WeatherMap from source has its own guide — coming soon.)

---

## Install

Two ways to deploy the zip. Use whichever access you have.

### Method A — Upload via Portal UI

Requires the Administrator role on the portal.

1. Log in to DX NetOps Portal as a user with the **Administrator** role.
2. **Administration → Configuration Settings → App Deployment.**
3. In the **App** field, browse and select `WeatherMap.zip`, then click
   **Add**. The portal unzips into `/pc/apps/user/WeatherMap/` — no
   restart needed.

**If this menu is missing or returns a permissions error**, your
account lacks the Administrator role — use Method B, or ask your
portal admin to grant it.

### Method B — Direct deploy via SSH

Use this when you have server access but not the portal Administrator
role. This unzips the app directly into the portal's user-apps
directory, bypassing the web UI.

1. **Find the apps directory** (the exact path varies by installation):
   ```bash
   ssh <user>@<portal-host>
   find /opt -type d -name 'user' 2>/dev/null | grep -i 'apps'
   ```
   Expected result on a standard install:
   ```
   /opt/CA/PerformanceCenter/PC/webapps/pc/apps/user
   ```
2. **Copy and extract the zip:**
   ```bash
   # From your local machine:
   scp WeatherMap.zip <user>@<portal-host>:/tmp/WeatherMap.zip

   # On the portal server:
   cd /opt/CA/PerformanceCenter/PC/webapps/pc/apps/user
   sudo unzip -o /tmp/WeatherMap.zip
   ```
   The `-o` flag overwrites existing files — safe for redeploying an
   update.
3. **Verify:**
   ```bash
   curl -sk -o /dev/null -w "%{http_code}" \
     https://<portal-host>/pc/apps/user/WeatherMap/index.html
   ```
   Should return `200`.

If `sudo unzip` leaves files owned by root and the portal needs write
access to them (rare), fix with:
```bash
sudo chown -R capc:capc /opt/CA/PerformanceCenter/PC/webapps/pc/apps/user/WeatherMap
```

Both methods deploy live — no portal restart needed either way. Once
deployed, continue to [Configure](#configure) before adding it to a
dashboard.

---

## Configure

All environment-specific values live in files that ship inside
`WeatherMap.zip`. Edit these directly in the deployed folder —
**no rebuild required**; just save and hard-refresh the dashboard.

### `appConfig.properties` — portal-facing metadata

```properties
appName=NetOps WeatherMap
description=...
url=index.html?id={ItemIdDA}&startTime={TimeStartUTC}&endTime={TimeEndUTC}
height=700
supportedContext=nc
```

Controls the iframe URL the portal navigates to (`{ItemIdDA}`,
`{TimeStartUTC}`, `{TimeEndUTC}` are substituted at runtime) and the App
View's display name/height in the portal picker.

### `runtime-config.json` — runtime values

Fetched by the App View at startup. Change a value, save, hard-refresh
the iframe — no build needed.

| Key | Purpose |
|---|---|
| `owmApiKey` | OpenWeatherMap API key for weather overlays and the popup's Weather tab. Get a free key at https://openweathermap.org/api. |
| `mapDefaults.center` / `.zoom` | Initial map view before devices load. Defaults to the continental US. |
| `clusterRadius` | Pixel radius for marker clustering. Lower = clusters break apart sooner as you zoom in. |
| `odata.topLimit` | Maximum devices returned per OData query. |
| `odata.resolution` | OData metric aggregation resolution (e.g. `RATE`, `HOUR`). |
| `powerOutages.apiUrl` | ODIN dataset endpoint for power-outage polygons. Defaults to the public ORNL mirror. |
| `powerOutages.maxRecords` | Pagination cap for ODIN. 5000 covers nationwide storms comfortably. |
| `triageViewPageId` | The Performance Center page id for Triage View in **your** environment. Required for the "Investigate in Triage View" deep-links to appear — set it to whichever page id your portal uses for the Triage View context page. Leave `null` to hide the deep-links. |

### Backend connections and Portal CSP

WeatherMap reaches Spectrum (required), and optionally AppNeta and the
Data Aggregator, through same-origin JSP proxies shipped inside the
zip. Wiring those up — and the one-time nginx CSP change your portal
needs for the weather, radar, and power-outage overlays to load — is
covered in **[Backend Configuration](docs/BACKEND_CONFIGURATION.md)**.

At minimum, configure the Spectrum proxy before going live. AppNeta and
the Data Aggregator deep-link are optional.

---

## Run

1. Open or create a **group-level dashboard** in NetOps Portal.
2. Edit it → **Add App View** → pick **NetOps WeatherMap** from the
   dropdown → save.
3. The map should auto-zoom to fit your group's devices.

**Smoke test before wiring up real credentials:** append `?debug=1` to
the App View's URL to render sample devices across the US without
hitting Spectrum, PC OData, or AppNeta at all. If you see a populated
map with `?debug=1` but a blank one without it, the deployment itself
is fine and the issue is in your backend configuration — see
[Backend Configuration](docs/BACKEND_CONFIGURATION.md).

---

## Troubleshooting

Issues with Spectrum, AppNeta, or Data Aggregator proxies, or with the
portal's Content-Security-Policy, are covered in
[Backend Configuration](docs/BACKEND_CONFIGURATION.md#troubleshooting)
instead of here.

**Status banner: "Failed to load runtime-config.json"** — the file is
missing, malformed JSON, or blocked by CSP. Check the browser console.

**Status banner: "No geo-located devices found"** — the group either has
no devices, or none of them have `Latitude` / `Longitude` set in NetOps.

**No SD-WAN tunnels showing** — the PC OData query returned no tunnels
for the group, or the proxied call failed. Check DevTools → Network for
`/pc/odata4/api/tunnels` and verify the response.

**"Investigate in Triage View" link doesn't appear** —
`triageViewPageId` in `runtime-config.json` is null. Set it to the
Triage View page id for your environment.

**Weather tab says "Couldn't load weather"** — either the OWM API key is
bad (rotate it in `runtime-config.json`), or your portal's CSP isn't
whitelisting OpenWeatherMap — see
[Backend Configuration](docs/BACKEND_CONFIGURATION.md).

**Power Outages overlay shows no count or stays empty** — first check
whether your portal's CSP allows the ODIN API (see
[Backend Configuration](docs/BACKEND_CONFIGURATION.md)). If CSP is fine,
note that ODIN coverage is voluntary — some utilities (notably FPL in
Florida, PG&E in Northern California) don't participate, so absence of
polygons in those areas may be real, not a bug.

**Old version showing after redeploy** — the browser caches the iframe's
JS bundle. Hard refresh (Ctrl+Shift+R) or use an incognito window.

---

#### Copyright (c) 2026 CA Technologies, A Broadcom Company

The MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
