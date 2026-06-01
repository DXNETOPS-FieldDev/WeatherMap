---
name: appneta-mps
description: Query the AppNeta REST API for Monitoring Point inventory and Network Path metrics, and render them on a NetOps App View map. Use this skill when an App View needs to show AppNeta MPs, their measured paths to other MPs / ISPs / endpoints, or jitter / latency / loss / MOS metrics from AppNeta. Covers v3 vs v4 differences, why PC OData alone is insufficient, multi-tenant orgId routing on demo.pm.appneta.com, the bulk-metric endpoint that AppNeta's official docs don't lead with, the v3↔v4 ID bit-mask conversion, and rendering pitfalls (MP↔target vs MP↔MP, sentinel values, icon z-ordering above clusters). Captures everything from the WeatherMap session so the next AppNeta integration ships without re-discovering it.
---

# AppNeta MPs + Network Paths

When an App View needs to show **AppNeta Monitoring Points** and the **Network Paths** between them, you need TWO different surfaces glued together — and the obvious one is the wrong one. This skill captures what we learned the hard way.

## Where the data lives

| Surface | Has | Missing | Auth | Use when |
|---|---|---|---|---|
| **PC OData v4** `/pc/odata4/api/` | `sdnpathmfs` — **Network Path metric** records | **Path inventory** (no parent entity — every EntityType is exposed and none has the path identity) | PC session cookie (same as devices) | Never alone — metrics-without-identity. |
| **AppNeta REST v3** `<host>/api/v3/` | Path inventory + bulk metrics + per-path metrics | Per-MP rich detail (use v4 for that) | `Authorization: Token <key>` | Inventory + metrics. Default choice. |
| **AppNeta REST v4** `<host>/api/v4/` | Cleaner inventory (`sourceMonitoringPoint{id,name}` instead of bare strings), per-MP detail, deep-links | **No metric endpoint** (returns 404 for `/data`, `/metric`, `/metrics`) | Same Token header | Inventory only; pair with v3 for metrics. |

### Critical confirmations

- **PC OData's `sdnpathmfs` is metrics-only.** Annotated `Summary: Network Path` and carries the full AppNeta metric set (Latency, RoundTripTime, Inbound/OutboundDataJitter, Inbound/OutboundVoiceJitter, MeanOpinionScore, Capacity Available/Total/Utilized). But every `device.sdnpathmfs` reverse-navigation returns empty, and forward `$expand=device/sdndevice/router` on a metric record returns null for every nav property. The `DeviceItemID` always equals the row `ID` and resolves to nothing in `devices`, `interfaces`, `components`, or `aggregatedcomponents`. Confirmed by checking all 177 EntityTypes in `$metadata`.
- **`demo.pm.appneta.com` is multi-tenant.** Same SaaS host serves AppNeta's public marketing demo (orgId 3) AND customer dev environments (orgId 19584 for ours). The `?orgId=N` query param is the tenant selector. Auth + endpoints are identical across orgs.
- **v4 path IDs = v3 path IDs + 2^40.** So `v3_id = v4_id & 0xFFFFFFFFFF` (bit mask) or `v4_id - 1099511627776`. Verified: v4 `1099511926309` ↔ v3 `298533`. Use this if you mix v4 inventory + v3 metrics.

## Auth

```
Authorization: Token <api-key>
Accept: application/json
```

**Not** `Bearer`, **not** Basic. Generate the token in the AppNeta UI under user profile → API Access Tokens. The token is per-user, scoped to whichever orgs the user has access to.

In a browser App View the token must stay server-side — ship a **JSP same-origin proxy** that injects the header. See `[[app-view-jsp-proxy]]` for the pattern and `public/appneta-proxy.jsp` for a concrete implementation. AppNeta returns `Access-Control-Allow-Origin: *` so cross-origin isn't strictly the blocker — token secrecy is.

## Endpoint reference

### Inventory
| Endpoint | What it returns | Notes |
|---|---|---|
| `GET /api/v3/path?orgId=N` | All paths in the org | Unpaginated (~125 records seen). Use this. |
| `GET /api/v3/path?orgId=N&sourceAppliance=X&target=Y` | Filtered paths | Use for selective fetch. |
| `GET /api/v3/path/{id}` | Single path by v3 id | Numeric id only. |
| `GET /api/v4/networkPath?orgId=N` | Cleaner inventory | Paginated (~50/page default). Use only if you need v4 fields. |
| `GET /api/v4/networkPath/{id}` | Single path, no metrics inline | v4 id, large 64-bit. |
| `GET /api/v4/monitoringPoint?orgId=N` | MP records with `connectionStatus`, `interfaces[]`, etc. | Richer than what PC `/devices` returns. Paginated. |

### Metrics
| Endpoint | What it returns | Notes |
|---|---|---|
| `GET /api/v3/path/data?orgId=N&from=<sec>&to=<sec>` | **BULK — all paths' metrics in one call** | **Use this.** Despite AppNeta docs leading with per-path. |
| `GET /api/v3/path/{id}/data?from=<sec>&to=<sec>` | One path's metrics | Fall back only if bulk 404s. |
| v4 metric endpoints | None — every `/data`, `/metric`, `/metrics` 404s | v4 is inventory-only. |

## Query patterns

### Single bulk fetch — inventory + metrics in parallel

```js
const now = Math.floor(Date.now() / 1000)
const from = now - 300                                    // 5-min window
const headers = { Accept: 'application/json' }

const [invRes, metRes] = await Promise.all([
  fetch(`./appneta-proxy.jsp?path=${encodeURIComponent('v3/path')}`, { headers }),
  fetch(
    `./appneta-proxy.jsp?path=${encodeURIComponent('v3/path/data')}` +
      `&from=${from}&to=${now}`,
    { headers },
  ),
])
const inventory = await invRes.json()      // array of path records
const metricsList = await metRes.json()    // array of {pathId, instrumentation, data, dataInbound, dataOutbound}

// Join by id === pathId
const metricsById = new Map(metricsList.map((m) => [m.pathId, extractMetrics(m)]))
```

### Filter to renderable paths

```js
inventory
  .filter((p) =>
    devicesByName.has(p.sourceAppliance) &&    // source MP exists in PC
    p.targetLocation?.lat != null,             // target has geo
  )
  .map((p) => normalize(p, devicesByName.get(p.sourceAppliance), metricsById.get(p.id)))
```

### Extract one latest value per metric, with TWO_WAY collapse

```js
function latest(arr) {
  if (!Array.isArray(arr)) return null
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i]?.value
    if (v != null && v !== -1.0) return v       // sentinel skip — see Pitfall 3
  }
  return null
}
function worst(a, b, kind) {                     // for TWO_WAY in/out collapse
  if (a == null) return b
  if (b == null) return a
  return kind === 'max' ? Math.max(a, b) : Math.min(a, b)
}
function extractMetrics(record) {
  const data = record.data || {}
  if (record.instrumentation === 'TWO_WAY') {
    const inb = record.dataInbound || {}, out = record.dataOutbound || {}
    return {
      latency: latest(data.latency),             // round-trip lives on top-level data
      rtt: latest(data.rtt),
      dataLoss:   worst(latest(inb.dataLoss),   latest(out.dataLoss),   'max'),
      dataJitter: worst(latest(inb.dataJitter), latest(out.dataJitter), 'max'),
      voiceLoss:  worst(latest(inb.voiceLoss),  latest(out.voiceLoss),  'max'),
      voiceJitter:worst(latest(inb.voiceJitter),latest(out.voiceJitter),'max'),
      mos: worst(latest(inb.mos), latest(out.mos), 'min'),    // MOS inverted!
    }
  }
  // ONE_WAY: everything in `data`
  return { latency: latest(data.latency), rtt: latest(data.rtt), /* ... */ }
}
```

## Record shapes

### v3 inventory record
```json
{
  "id": 308108,
  "sourceAppliance": "dev-vk35-Miami-AppNeta",
  "target": "chicago-isp-1",
  "targetLocation": {"lat": 41.88, "lng": -87.63, "locality": "Chicago", "formattedAddress": "Chicago, IL", ...},
  "asymmetric": false,
  "networkProtocol": "ICMP" | "UDP" | "TCP",
  "ispName": "Lumen" | null,
  "monitoringStatus": "MONITORING",
  "pathName": "dev-vk35-Miami-AppNeta <-> chicago-isp-1 (single)",
  ...
}
```

### v4 monitoringPoint record (use for richer MP detail than PC's `/devices`)
```json
{
  "id": 1099511672928,
  "hostname": "dev-vk35-Miami-AppNeta",    // ← stable join key, see Pitfall 6
  "name": "Miami-AppNeta-vk35",            // human label, varies wildly
  "location": {"lat": 25.76, "lng": -80.19, "formattedAddress": "Miami, FL", ...},
  "connectionStatus": "ONLINE" | "OFFLINE",
  "type": "v35-KVM virtualAppliance" | "r90 rackAppliance" | "c50 Container" | "Windows" | "Global Monitoring Point",
  "interfaces": [{"ipAddress": "...", "cidr": "...", "speed": 1000, ...}],
  "tags": [...]
}
```

### v3 metric record
```json
{
  "pathId": 308108,
  "instrumentation": "TWO_WAY" | "ONE_WAY",
  "data": {
    "latency": [{"start": 1779902933609, "value": 24.896}, ...],
    "rtt": [...],
    // ONE_WAY only: loss/jitter/mos/capacity also here
  },
  "dataInbound": { /* per-direction metrics, TWO_WAY only */ },
  "dataOutbound": { /* per-direction metrics, TWO_WAY only */ }
}
```

## Pitfalls (each cost a deploy cycle or a debugging session)

### 1. Don't reach for PC OData first

`sdnpathmfs` looks like it should be the answer (annotated `Network Path`, metrics flowing). It isn't — **no inventory entity exists**. Every EntityType is exposed as an EntitySet, no hidden surfaces. Reverse-nav from MP returns empty, forward-nav from metric returns null. Save the day of probing — go straight to AppNeta REST v3.

### 2. Time-range params are SECONDS, metric timestamps are MILLISECONDS

`from` / `to` query params are **epoch seconds**. The `start` field inside metric arrays is **epoch milliseconds**. Off-by-1000 errors are easy. Always:

```js
const now = Math.floor(Date.now() / 1000)  // SECONDS
const from = now - 300
// but when comparing to metric.start:
const startSec = Math.floor(metric.start / 1000)
```

### 3. `-1.0` is the no-data sentinel

In any metric array (`latency`, `dataLoss`, `utilizedCapacity`, etc.), `value: -1.0` means "no data in this bucket." Skip them when picking the latest sample — walk back from the end of the array until you find a real value, or return `null`. **Never display -1.0 to the user.**

### 4. `limit=N` restricts paths returned, NOT samples per path

`/api/v3/path/data?limit=2` returns 2 path records each with their FULL time-series array (~100-200 points per metric). At full window with no `from`/`to`, payloads are MB-scale. **Always use `from`/`to` to trim** — 5-min window yields ~10 samples per metric per path.

### 5. The bulk metric endpoint exists, but AppNeta docs don't lead with it

AppNeta developers will tell you to use `/api/v3/path/{id}/data` per-path. At 125 paths that's 125 HTTP calls per refresh. The **bulk** `/api/v3/path/data?orgId=N&from&to` works (verified) and returns one record per path — one HTTP call per refresh, ~220 KB for 125 paths × 5-min window. Use bulk unless it 404s.

### 6. Join MP↔PC device by `hostname` / `sourceAppliance`, NOT `name`

AppNeta's `name` field has many conventions across deployments: `SanFrancisco-AppNeta-vk35`, `vk35-Portland-MP`, `Vancouver.BC-r90`, `dev-vk35-Miami-AppNeta`. **Stable identifiers:**
- v4: `monitoringPoint.hostname`
- v3 paths: `path.sourceAppliance`

In a customer dev env, these typically match PC `devices.Name` exactly (e.g. PC `dev-vk35-Miami-AppNeta` == AppNeta `sourceAppliance: dev-vk35-Miami-AppNeta`). The "strip the dev- prefix" heuristic seen on the AppNeta public demo org is wrong for customer environments — names come in already-prefixed. Use direct equality first.

### 7. `asymmetric` is misnamed

In v3 inventory, `asymmetric: true` means **dual-ended** (TWO_WAY metric instrumentation, with `dataInbound`/`dataOutbound`). `asymmetric: false` means single-ended (ONE_WAY). v4 fixed this with the `dualEnded` field. Don't confuse with network-asymmetric-route semantics — it isn't that.

### 8. MOS scoring is inverted

MOS (Mean Opinion Score) ranges 1.0–4.5. **Smaller = worse** (voice quality degrading). Every other metric in the set (latency, loss, jitter, RTT) is larger = worse. When computing worst-of-direction for TWO_WAY, MOS uses `min`, everything else uses `max`. When mapping to a band/color, MOS needs reversed thresholds (`[4.0, 3.5, 3.0]` with smaller-band-index meaning bad).

### 9. AppNeta paths are usually MP→target, not MP↔MP

In the customer dev org, **0 of 125 paths were MP↔MP** — all targeted an ISP label (`chicago-isp-1`), raw IP, or hostname (`demo.pm.appneta.com`). The customer expectation may be "lines between MPs"; the reality is "lines from MP to monitored endpoint." Of the non-MP targets:
- ~64% had `targetLocation.lat/lng` populated (renderable as a line to a geographic anchor)
- ~36% had no geo (raw IP / hostname with no DNS resolution) — unrenderable

Surface this expectation/reality mismatch with the customer before designing the layer. AppNeta supports MP↔MP paths but they have to be explicitly configured.

### 10. v4 has no metric endpoint

Don't waste a session looking for it. `/api/v4/networkPath/{id}/data`, `/metric`, `/metrics` all 404. v4 single-path returns inventory only. **Hybrid (v4 inventory + v3 metrics via ID bit-mask) works**, but for v1 the all-v3 path is simpler and equally complete.

### 11. Always group-filter MP queries against PC

When fetching the PC-side MP devices for the join, filter by the current group context: `groups/any(L1:L1/ID eq <id>)`. Otherwise you'll pull MPs from outside the user's group (e.g. a Backbone-London-MP that belongs to a Global Backbone group), causing line endpoints to render in unexpected geographic locations. Mirror what `fetchDevices()` in `odata.js` does.

### 12. The cube icon felt heavy — bullseye/target is the v1 default

We tried the customer-supplied AppNeta cube logo as a 32×32 marker icon. Visually overpowering and overlapped with cluster bubbles unpleasantly. The pattern that landed: an SVG bullseye (thick black stroked circle, see-through center, small center dot) at 34px, with `zIndexOffset: 1000` so it stacks above cluster markers regardless of click order. The cube file (`public/appneta-mp-icon.png`) stays in the repo as a reminder.

### 13. Curve-bow hash needs avalanche — don't copy TunnelLayer's plain djb2

`[[pc-sdwan-tunnels]]`'s `hashStr(s) = (h<<5) - h + c` works fine for tunnels because they're grouped before rendering (one polyline per source-dest pair, no overlap possible). AppNeta paths are NOT grouped — each path gets its own polyline — so the hash needs much better dispersion. The plain djb2 variant produces hashes that differ by ~1 for two strings whose only difference is a single character at the end, which after `(h % 2000) / 1000` becomes a 0.001 difference. Multiplied by `curveMagnitude` that's ~110m of physical separation — **visually invisible at any zoom**.

Real symptom from the WeatherMap session: Denver had 2 paths going to NYC (one for `ny-isp-1`, one for `ny-isp-2`, path IDs 309617 and 309618). Both rendered as a single overlapping line; user reported "I only see one Denver line."

Fix: add a Knuth multiplicative avalanche after the djb2 sum:

```js
function hashStr(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) + s.charCodeAt(i)) | 0    // djb2 step
  }
  h = Math.imul(h ^ (h >>> 16), 2654435761)        // avalanche
  return (((h >>> 0) % 2000) / 1000) - 1
}
```

Verified: the Denver pair now hashes to `+0.78` and `-0.31` — a 1.08 separation, opposite-direction curves clearly visible. If you ever lift this pattern into a different layer where polylines aren't grouped, use the avalanche variant from the start. (TunnelLayer doesn't need it because pairKey grouping happens upstream.)

### 14. Filter MPs to path-sources only — name-pattern fetch yields rogues

`fetchAppNetaMpDevices()` pulls every PC device whose name matches `vk35` / `appneta` / `*-MP`. That set is broader than the MPs actually generating renderable paths. In the dev org, `dev-SanFrancisco-EXT-AppNeta-vk35` matched the name filter and was in the Demo-Sites group — so it landed in `appnetaMps` and rendered a bullseye marker — but it wasn't a source of any visible path, so it had no row in the legend.

Symptom: user unchecked every MP in the legend, but one rogue bullseye stayed on the map (nothing in the legend to dismiss it with).

Fix: derive `renderableAppnetaMps` from `appnetaMps ∩ {paths[].sourceDeviceId}` and use that everywhere the MP universe matters (layer rendering, cluster-exclusion filter, select-all callback). MPs without paths fall through to the regular device cluster — they don't vanish entirely, just don't pretend to be AppNeta entities they're not.

```js
const renderableAppnetaMps = useMemo(() => {
  const sourceIds = new Set(appnetaPaths.map((p) => p.sourceDeviceId))
  return appnetaMps.filter((m) => sourceIds.has(m.id))
}, [appnetaMps, appnetaPaths])
```

**Escape hatch for fleet-view customers** — some customers want every AppNeta MP visible even when it's not currently generating paths (fleet management view where idle MPs still matter). Opt-in via `showOrphanAppnetaMps: true` in `runtime-config.json`. When on, derive `orphanAppnetaMps = appnetaMps - renderableAppnetaMps` and append them to the layer's MP list AND to the cluster-exclusion set (so they don't double-render with the cluster). Crucially, orphans get **no legend row**, so the legend's select-all leaves them alone — they're a persistent "always show" lane independent of per-row controls.

```js
const orphanAppnetaMps = useMemo(() => {
  if (!config.showOrphanAppnetaMps) return []
  const sourceIds = new Set(appnetaPaths.map((p) => p.sourceDeviceId))
  return appnetaMps.filter((m) => !sourceIds.has(m.id))
}, [appnetaMps, appnetaPaths, config.showOrphanAppnetaMps])

const visibleAppnetaMps = useMemo(() => [
  ...renderableAppnetaMps.filter((m) => !hiddenAppnetaMpIds.has(m.id)),
  ...orphanAppnetaMps,  // never filtered by legend hidden set
], [renderableAppnetaMps, hiddenAppnetaMpIds, orphanAppnetaMps])
```

### 15. Don't early-return null from a Leaflet LayerGroup inside an Overlay

`AppNetaLayer` originally bailed with `if (paths.length === 0) return null` for the "no data" case. When user filters caused `visibleAppnetaPaths` to go empty, the LayerGroup unmounted; React-Leaflet's `Overlay` then lost the layer reference, and re-populating the array did NOT bring the layer back — the Overlay's checkbox stayed checked but rendered nothing.

Fix: always return the LayerGroup, even when its children arrays are empty. React-Leaflet keeps the Overlay/layer attachment stable, and empty arrays just render zero markers.

```jsx
export default function AppNetaLayer({ paths, appnetaMps }) {
  const safePaths = paths || []
  const safeMps = appnetaMps || []
  // ... rest, no early null return
  return <LayerGroup>{/* empty when arrays are empty, but still mounted */}</LayerGroup>
}
```

Applies to any layer whose data can be filtered to empty by a sibling control (legend, search box, etc.).

## Visualization patterns

### Render MPs as a bullseye marker via L.divIcon + inline SVG

```js
const MP_ICON = L.divIcon({
  html:
    '<svg width="34" height="34" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="17" cy="17" r="13" stroke="#000" stroke-width="7" fill="none" />' +
      '<circle cx="17" cy="17" r="2" fill="#000" />' +
    '</svg>',
  className: 'appneta-mp-target',
  iconSize: [34, 34],
  iconAnchor: [17, 17],
  popupAnchor: [0, -17],
})
```

Thick stroke (the dark ring) + transparent inside (cluster bubble at the same coord shows through) + small center bullseye dot. Sized so the outer ring extends past a typical 28px cluster bubble.

### Always render source MPs from the AppNeta layer, with zIndexOffset

```jsx
<Marker ... icon={MP_ICON} zIndexOffset={1000}>
```

Render every source MP (don't skip ones already in the cluster). `zIndexOffset={1000}` keeps the bullseye visually above any cluster bubble at the same coord. Otherwise clicking the cluster first buries the MP.

### Filter AppNeta MPs OUT of the device cluster when the layer is on

To avoid double-rendering (cluster bubble + bullseye both representing the same device), exclude AppNeta MP IDs from the cluster's children when the AppNeta overlay is checked. **Use `renderableAppnetaMps` (path-sources only), NOT the raw `appnetaMps`** — see Pitfall 14. MPs without paths would otherwise disappear from both the AppNeta layer (no path = no bullseye) and the cluster (excluded by this filter), leaving them with no representation at all.

```jsx
const appnetaMpIdSet = useMemo(() => new Set(renderableAppnetaMps.map((m) => m.id)), [renderableAppnetaMps])
const clusterDevices = useMemo(
  () => appnetaLayerOn
    ? devicesWithOutages.filter((d) => !appnetaMpIdSet.has(d.id))
    : devicesWithOutages,
  [devicesWithOutages, appnetaLayerOn, appnetaMpIdSet],
)
```

Co-located OTHER devices (SDWan edges in the same city) stay in the cluster — only the MP itself is moved to the AppNeta layer.

### Target endpoints get a small grey CircleMarker

Render one `<CircleMarker radius=4 color=grey>` per unique `(targetLat, targetLng)` pair, with a popup listing every path that terminates there. Multiple `Miami → chicago-isp-1` and `Miami → chicago-isp-2` paths share the same Chicago coordinate — group them so you don't pile 8 anchors on top of each other.

### Curved Bezier polylines, same pattern as tunnels — but with a better hash

Use the same Bezier-curve fan-out as `[[pc-sdwan-tunnels]]` — each path's polyline bowed by `curveMagnitude * hash(pairKey)` so MP↔same-target lines (e.g. 4 MPs all pointing at chicago-isp-1) don't overlap. Threshold-band coloring (green/yellow/orange/red) on the worst of latency/dataLoss/dataJitter.

**Use the avalanche-mixed hash, NOT the plain djb2 from TunnelLayer** — see Pitfall 13. Tunnels are grouped before rendering so one hash per pair is fine; AppNeta polylines render one per path, so the hash must disperse consecutive numeric IDs across the full output range or sibling paths from the same MP collapse onto a single curve.

### Tri-state "select all" header checkbox in the legend

When the legend has many per-row visibility checkboxes, users want a way to flip them all at once. Pattern that works inside the legend's in-place DOM update model (effect 1 + delegated change listener, no React per-row):

1. **Render** a header `<input type="checkbox" data-toggle-all>` in the table head's check column. Use the same delegated `change` listener that handles per-row checkboxes; branch on `cb.hasAttribute('data-toggle-all')` vs `cb.dataset.deviceId != null`.
2. **Tri-state** after every `innerHTML` swap — `indeterminate` must be set as a JS property, not an HTML attribute, so this happens AFTER the table is in the DOM:
   ```js
   const headerCb = wrapEl.querySelector('input[data-toggle-all]')
   if (headerCb) {
     const allVisible  = rows.length > 0 && rows.every((r) => !hidden.has(r.id))
     const noneVisible = rows.length > 0 && rows.every((r) =>  hidden.has(r.id))
     headerCb.checked = allVisible
     headerCb.indeterminate = !allVisible && !noneVisible
   }
   ```
3. **Callback contract**: `onToggleAll(visible: boolean)`. Receives the new desired state (true = check all). Parent rebuilds the hidden set:
   ```js
   const setAllAppnetaMpsVisible = useCallback((visible) => {
     setHiddenAppnetaMpIds(visible
       ? new Set()
       : new Set(renderableAppnetaMps.map((m) => m.id)))
   }, [renderableAppnetaMps])
   ```
   Use the SAME universe as the legend rows (path-sources only, per Pitfall 14) so "uncheck all" really empties the legend and "check all" doesn't accidentally try to un-hide MPs that never appeared.
4. **Hold the callback in a ref** (`onToggleAllRef`), same as `onToggleRef`, so the delegated listener (bound once in effect 1) always calls the latest version without making effect 1 re-run.

The same pattern works in any legend with per-row hide checkboxes — we mirrored it into `[[pc-sdwan-tunnels]]`'s TunnelLegend with one new App.jsx callback (`setAllTunnelDevicesVisible`) using `tunnels.flatMap(t => [t.sourceId, t.destId])` as the universe.

## Architecture (App View)

### File layout
- `public/appneta-proxy.jsp` + `public/appneta-proxy.properties` — same-origin proxy, mirrors `spectrum-proxy.jsp` with Token auth + server-side `orgId` injection
- `src/api/appneta.js` — exports `fetchAppNetaPaths()` + `fetchAppNetaMpDevices()`
- `src/components/AppNetaLayer.jsx` — Polylines + MP Markers + target CircleMarkers, wrapped in `LayerGroup`
- `src/components/AppNetaLegend.jsx` — Leaflet `L.control` panel, mirror of `TunnelLegend` (two-effect DOM-preservation pattern is load-bearing)

### Config (runtime-config.json)
```json
"appnetaPaths": {
  "lookbackSeconds": 300,
  "refreshIntervalMs": 60000,
  "curveMagnitude": 0.9,
  "thresholds": {
    "latency": [100, 300, 500],
    "dataLoss": [1, 3, 5],
    "dataJitter": [10, 30, 50]
  }
},
"showAppNetaPaths": true,         // master switch: overlay control + fetchers
"showAppNetaLegend": true,        // legend visibility (combined with overlay-on state)
"showOrphanAppnetaMps": false     // also render MPs with no paths (fleet view) — see Pitfall 14
```

### Proxy whitelist (in JSP)
```java
Pattern.compile(
  "^(v3/path(/data)?|v3/path/\\d+(/data)?|" +
   "v4/networkPath(/\\d+)?|v4/monitoringPoint(/\\d+)?)$"
)
```

### Polling cadence
- **Inventory** + **bulk metrics** every 60s, with `from = now - 300, to = now`. Small payload (~220 KB for 125 paths), fresh enough for a NOC view.
- MP devices fetched once on layer-enable; data is stable.

## Related

- `[[pc-sdwan-tunnels]]` — same curved-polyline + threshold-band pattern; AppNeta layer reuses the visualization vocabulary
- `[[app-view-jsp-proxy]]` — the JSP same-origin proxy pattern (Spectrum + AppNeta both use it)
- `[[pc-jsp-environment]]` memory — Jetty 12 / Jakarta Servlet 6 constraints on `dev-netops` PC; relevant when modifying proxy code
- `[[netops-app-view]]` — App View shell, group-context URL params, deployment via WeatherMap.zip
