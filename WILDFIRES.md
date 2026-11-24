# Wildfires — Feature Brief

A togglable layer in the NetOps WeatherMap that overlays **active wildfires in the US and Canada** on the same map as your
network devices, and flags devices that are **inside a fire perimeter**, or, if you choose, **within a set
distance of a fire**.

Like the Power Outages layer, it needs no extra servers and no licence: the users' browsers read a free public
feed directly. This brief is deliberately candid about what the feature does **not** do.

---

## What the operator sees

1. **A "Wildfires (N)" toggle** in the Env layer control (off by default). N is the number of distinct fires
   named in device popups (the devices currently on the map), the same rule as "Power Outages (N)".
2. **Fire perimeters** as shaded polygons, and **fires without a mapped perimeter yet** as small 🔥 markers at
   their reported location. Active fires are red-orange; fires reported 100% contained are muted. Device
   markers always stay on top.
3. **A popup per fire**: name and state, acres, % contained, discovery date and last update. Canadian fires
   show the agency's fire number and province (or Parks Canada), size in hectares with acres in brackets, the
   stage of control (out of control, being held, under control) and the last update.
4. **A banner in a device's Site Info popup** when it is affected:
   > 🔥 **Inside an active wildfire perimeter** — Tedford (AL) · 10 acres · Discovered Nov 15, 2026 · updated Nov 17, 2026

   or, with `nearbyMiles` set:
   > 🔥 **Active wildfire about 84 mi away** — Wolf Skull (AL) · 55 acres · Discovered Nov 18, 2026 · updated Nov 19, 2026

   or, for a Canadian fire:
   > 🔥 **Active wildfire about 98 mi away** — Fire 2026-N22363 (BC) · less than 1 ha · Under control · Updated Nov 3, 2026 · Source: CWFIS (Canada)

---

## Where the data comes from

### US

| Aspect | Value |
|---|---|
| Source | **NIFC WFIGS** — Wildland Fire Interagency Geospatial Services, National Interagency Fire Center |
| Datasets | *WFIGS Current Interagency Fire Perimeters* and *Current Wildland Fire Incident Locations* (owner `NIFC_Authoritative`) |
| Cost | **Free, no API key** |
| Terms | Public federal data; the published licence is a warranty disclaimer only |
| Coverage | **US only** (including Puerto Rico) |
| Freshness | Incident records were updated within 2 hours of our check on 2026-11-20; perimeters as of the previous evening |
| Size | About 230 KB of perimeters and 90 KB of incidents per refresh (simplified shapes, only the fields shown) |
| Refresh | Every 15 minutes (`wildfires.refreshIntervalMs`) |

On 2026-11-20 the feeds held **55 perimeters** and **242 wildfire incidents** (wildfires and complexes). The
incident feed also lists **about 400 prescribed burns**, which this layer leaves out: they are planned, not a
threat.

### Canada

| Aspect | Value |
|---|---|
| Source | **CWFIS** — Canadian Wildland Fire Information System, Natural Resources Canada: the national active-fires layer, merged from the provinces, territories and Parks Canada |
| Cost | **Free, no API key** |
| Terms | Open Government Licence – Canada; the map shows the attribution statement it requires |
| Coverage | **Canada** |
| What it holds | One location per fire (no perimeters), size in hectares, stage of control |
| Freshness | Records updated the same day as our check on 2026-11-23 |
| Refresh | With the US fires (`wildfires.refreshIntervalMs`) |

**Only fires updated in the last 30 days are shown.** Agencies keep many fires open for months while only
monitoring them, often in remote areas. On 2026-11-23 the layer listed 90 "current" fires, but 66 had not been
updated in over 90 days (some since 2020) and only 9 within 30 days. Calling a fire last touched months ago an
"active wildfire" near a site would mislead the operator, so those are left out.

---

## How "affected" is decided

- **Inside (always on):** the device's coordinates fall inside a fire perimeter, using the same polygon test as
  Power Outages.
- **Nearby (optional):** set `wildfires.nearbyMiles` in `runtime-config.json` to a positive number, for example
  `10`. A device within that many miles of a fire is flagged with the distance. Distance is measured to the
  perimeter's edge, or to the reported location when the fire has no perimeter yet. `0` (the default) turns
  this off.
- Inside beats nearby; the nearest fire wins.
- **Canadian fires have no perimeters**, so they flag a device only when `nearbyMiles` is set.

The matching was checked against an independent recount from the same data. On dev, with a 150-mile
radius, the app and the recount agreed: 10 fires across 83 devices, device by device.

---

## What you're NOT getting (honest limitations)

1. **US and Canada only.** Europe and global satellite detections (NASA FIRMS) are possible later phases. FIRMS
   needs a server-side proxy and a free key.
2. **Perimeters lag behind small and new fires.** A fire is often reported as a location hours or days before a
   perimeter is mapped. "Inside" only works where a perimeter exists, which is why `nearbyMiles` exists.
3. **"Current" isn't always "burning".** A fire stays in the feed until it is declared out, which can be weeks
   after it is fully contained. The popup shows % contained and the dates so operators can judge.
4. **Not for safety decisions.** This is NOC context, like Power Outages. Evacuation and safety decisions belong
   to official sources.
5. **The browser must reach NIFC and CWFIS.** Users' browsers call `services3.arcgis.com` (US) and
   `geoserver.cwfif.nrcan.gc.ca` (Canada). The Portal's Content-Security-Policy must allow both in `connect-src` (see Backend Configuration), and the network must
   allow it, as for the weather and outage feeds. The connectivity check tests the route from the Portal server.

---

## Turning it off

Remove the `wildfires` section from `runtime-config.json`: the toggle disappears and nothing is fetched. To
turn off one country only, remove `canadaUrl` (Canada) or `perimetersUrl` and `incidentsUrl` (US).
