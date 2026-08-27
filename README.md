# NetOps WeatherMap — App View for DX NetOps Portal

A geographic, single-pane operations view that puts your network **on the
map** — devices, SD-WAN tunnels, AppNeta paths, alarms, weather, and
power-grid events all in one place — so operators can spot what's going
wrong, *where*, in the first second of looking.

![NetOps WeatherMap](docs/weathermap-screenshot.png)

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

- A NetOps Portal admin account, to reach **Administration →
  Configuration Settings → App Deployment**
- SSH + sudo access to the NetOps Portal server — needed to allow
  WeatherMap's file types ([Install](#install)), run `setup.sh`
  ([Configure](#configure)), and make the one-time Portal CSP change
  via `SsoConfig`, see
  [Backend Configuration](docs/BACKEND_CONFIGURATION.md)
- *(Optional)* Access to a Spectrum instance + credentials, for device
  alarm severity coloring. If you don't have Spectrum, WeatherMap
  still renders devices from Performance Center — they just show as
  normal/green instead of colored by alarm severity.
- *(Optional)* An AppNeta tenant + API token, if you want the AppNeta
  Monitoring Points feature

---

## Download

Go to **[this repository's latest release](https://github.com/DXNETOPS-FieldDev/WeatherMap/releases/latest)**
and download the `WeatherMap.zip` file attached to it — that link
always points at the newest release, so it's safe to bookmark.

> ⚠️ **Do not deploy this repository directly.** Cloning this repo or
> using GitHub's **Code → Download ZIP** gives you *source code* that
> has never been built — it will not run, and NetOps Portal won't even
> list it as an App View. Make sure what you're about to deploy is the
> pre-built **`WeatherMap.zip`** from the [Download](#download) section
> above, not a raw clone or source download.
>
> This guide covers downloading, installing, configuring, and running
> WeatherMap from that pre-built release. Building it from source
> yourself (only needed if you're modifying the app) is covered in the
> [Build Guide](docs/BUILD.md).

---

## Install

WeatherMap installs through the Portal's **App Deployment** page. Two
steps: allow its file types once, then upload the zip.

You'll still need shell access to the Portal server — for Step 1, and
again in [Configure](#configure).

### Step 1 — Allow WeatherMap's file types *(one-time, per Portal)*

The upload page checks every file in the zip against an allowlist, and
rejects the whole archive — *"Apps that contain invalid files are not
allowed"* — without saying which file tripped it. WeatherMap ships
`.sh`, `.csv`, `.jsp`, and `.properties.example` files, so the
allowlist needs to cover them.

On the Portal server, open:

```
<PC_HOME>/PC/webapps/pc/WEB-INF/cfg/portal.console.properties
```

Find `appDeploymentExtensionWhitelist` and **append** `,sh,csv,example`
to the end of the existing line. If the property isn't there at all,
add this line as-is:

```properties
appDeploymentExtensionWhitelist=jpg,png,gif,svg,css,js,html,xhtml,properties,md,txt,xml,json,gitignore,jsp,zip,sh,csv,example
```

> **Append — don't replace.** This setting *is* the allowlist, so
> whatever you write becomes the complete list. Drop an extension
> that's already there and other apps stop uploading.
>
> **`.jsp` must be on the list.** WeatherMap's Spectrum, AppNeta, and
> Data Aggregator proxies are JSPs. Some Portal versions leave `.jsp`
> off by default as a security control, because JSPs execute on the
> server — so this is worth a conscious nod from whoever owns the
> Portal, not just a paste.

Restart the console service so the new list is read:

```bash
sudo systemctl restart caperfcenter_console
```

### Step 2 — Upload the zip

In the Portal: **Administration** → **Configuration Settings** →
**App Deployment** → select `WeatherMap.zip` → **Add**.

If WeatherMap is already deployed, tick **Replace existing apps** —
without it the upload is refused (nothing is written, so a refused
upload leaves your install untouched).

> ⚠️ **Upgrading? "Replace" deletes the folder and re-extracts it.**
> Every file not in the zip is removed — including the `.properties`
> files holding your Spectrum, AppNeta, and Data Aggregator
> credentials, which releases never ship. Back them up first, then
> restore them after the upload (or just re-run `setup.sh`):
> ```bash
> cd <PC_HOME>/PC/webapps/pc/apps/user/WeatherMap
> mkdir -p ~/weathermap-config-backup
> cp *-proxy.properties ~/weathermap-config-backup/
> ```

The app is live as soon as the upload finishes — no restart needed for
this step (the one in Step 1 is one-time). It won't do anything useful
yet, though: continue to [Configure](#configure).

---

## Configure

All environment-specific values live in files that ship inside
`WeatherMap.zip`. Edit these directly in the deployed folder —
**no rebuild required**. (Editing a `.properties` file after the app
has already run does require a Performance Center restart; see the
note under step 1.)

WeatherMap always pulls device inventory and metrics from Performance
Center's own OData API, with nothing to configure. Spectrum (alarm
severity), AppNeta (Monitoring Points), and the AppNeta path → PC
deep-link are optional add-ons, configured below — WeatherMap runs
fine with none of them, just with fewer features.

The two steps below assume NetOps Portal does **not** sit behind a
reverse proxy — the common case. If it does, finish these steps
first, then see
[Reverse proxy configuration](docs/BACKEND_CONFIGURATION.md#reverse-proxy-configuration).

### 1. Run `setup.sh`

No Node/npm needed — this is a plain script included in the deployed
folder.

```bash
ssh <user>@<portal-host>
cd <PC_HOME>/PC/webapps/pc/apps/user/WeatherMap
bash setup.sh
```

> **Use `bash setup.sh`, not `./setup.sh`.** The App Deployment upload
> strips the executable bit, so `./setup.sh` fails with `Permission
> denied`.
>
> **Run it as the OS user that runs Performance Center** — the owner of
> the deployed folder, which the upload created. That user needs write
> access there, and the `.properties` files the script writes have to
> stay readable by the Portal's JVM. The script sets them to mode `600`
> and matches them to the folder's owner, since they hold your
> passwords and API tokens.

It walks through, in order:
- **Spectrum** (optional — say no if you don't have Spectrum)
- **AppNeta** (optional — say no if you're not using Monitoring Points)
- **Data Aggregator** (asked whenever you configure AppNeta — needed
  for AppNeta path titles to link into PC)
- **Triage View page id** — find this by opening Triage View in your
  Portal and reading the page id out of the URL. Leave it blank to
  hide those links instead.

Safe to re-run later — it asks before overwriting a file you've
already configured.

> **If you change a `.properties` file after the app has already served
> one request, restart Performance Center.** Each proxy JSP reads its
> `.properties` file once per JVM lifetime and caches the values in
> memory, so later edits are ignored until the process restarts:
> ```bash
> sudo systemctl restart caperfcenter_console
> ```
> (Service name on a stock install; confirm with
> `systemctl list-units --type=service | grep -i caperfcenter`.) A
> first-time `setup.sh` run on a fresh deployment needs no restart —
> nothing has been cached yet.
>
> `runtime-config.json` is different: it's fetched by the browser on
> every page load, so those changes apply on a plain refresh.

### 2. Configure Portal CSP *(required)*

NetOps Portal's default Content-Security-Policy blocks the external
origins WeatherMap's weather, radar, and power-outage overlays need —
without this step, those features silently fail. Steps and the exact
value to paste are in
[Portal CSP requirements](docs/BACKEND_CONFIGURATION.md#portal-csp-requirements).

That's it — continue to [Run](#run).

See [Reference: other files you can tweak](docs/BACKEND_CONFIGURATION.md#reference-other-files-you-can-tweak)
in Backend Configuration for `appConfig.properties` and
`runtime-config.json` details — including the `triageViewPageId`
value you must change before going live.

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

See [Troubleshooting](docs/BACKEND_CONFIGURATION.md#troubleshooting)
in Backend Configuration.

---

## Data Sources & Attributions

WeatherMap displays data from several third-party services. Some require
visible attribution as a condition of their free API terms; others are
credited as a courtesy.

| Source | Used for | Attribution |
|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | Base map tiles | Required by OSM's tile usage policy. Shown in the map's attribution corner whenever the map is displayed. |
| [OpenWeatherMap](https://openweathermap.org/) | Precipitation / temperature / wind / clouds overlays, current-conditions popup | Required by OWM's terms. Shown in the map's attribution corner while any weather overlay is active. |
| [RainViewer](https://www.rainviewer.com/) | Animated radar playback | Required under RainViewer's free API terms ("Weather data by RainViewer" with a link back to rainviewer.com). Shown in the map's attribution corner while the radar overlay is active. |
| [ODIN](https://ornl.opendatasoft.com/) (DoE / Oak Ridge National Laboratory) | Power-grid outage overlay | Courtesy credit — no explicit attribution requirement was found in ODIN's published terms. |

Software licenses for the open-source libraries WeatherMap is built on —
including two items flagged for legal review — are in
**[LICENSE.md](LICENSE.md)**.
