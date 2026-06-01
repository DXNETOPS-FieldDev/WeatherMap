---
name: pc-sdwan-tunnels
description: Fetch SD-WAN tunnel inventory and quality metrics from DX NetOps Performance Center's OData v4 API, and render them as inter-device connectivity lines on a NetOps App View map. Use this skill when an App View needs to show device-to-device links (Viptela tunnels, Versa tunnels, generic SD-WAN overlays) with jitter / latency / packet-loss styling, or when designing any feature whose data lives in PC's OData layer rather than Spectrum. Captures the pitfalls (pagination, open-bucket aggregates, tunnel-name parsing, line-overlap visualization) from the WeatherMap WeatherMap session so the next implementation avoids them.
---

# PC OData SD-WAN Tunnel Visualization

When an App View needs to draw **connectivity between devices** (SD-WAN tunnels, SLA paths, BGP sessions, etc.) PC's OData service is the authoritative source — **not Spectrum**. Spectrum's `/connectivity/<ip>` was empty for every Viptela device in dev-netops; its `Gen_IF_Port` model type returns `NoSuchAttribute` for every standard port-health field. PC OData has it all, in a clean entity-relational model.

This skill captures **everything that broke in the WeatherMap session** so the next inter-device-link feature ships without the same debugging cycle.

## Where the data lives

| Entity | What it has | Why you care |
|---|---|---|
| **`sdntunnels`** | One row per logical tunnel. `SourceDeviceID`, `DestinationDeviceID`, `SourceInterfaceID`, `DestinationInterfaceID`, `Name` | Endpoints + naming. `SourceDeviceID` matches the `ID` you already use in `/devices`. |
| **`sdntunnelmfs`** | Time-series metric family. Composite key `(ID, Timestamp, Resolution)`. Fields: `im_Jitter`, `im_Latency`, `im_PacketLossPercentage`, `im_PctTimeinUpState`, `im_BytesIn/Out`, etc. | The Jitter / Latency / Loss popup metrics. |
| `sdndevices` | SD-WAN device-specific fields | Use the normal `devices` entity for geo — `sdndevices` is for vendor metadata. |
| `sdnvirtualinterfaces` | SD-WAN VPN interfaces | Endpoint metadata if you need port-level detail. |
| `sdnslapaths` / `sdnslapathmfs` | SLA paths (one level up from tunnels) | Alternative aggregation if tunnels are too granular. |
| `lldpmfs` | LLDP neighbor metrics | **Empty in dev-netops** — would be the source for L2 topology if your customer has it polled. |

Base URL is `/pc/odata4/api/` (relative — uses the user's PC session cookie). Full service document at `/pc/odata4/api/` lists every entity set. **`includeAppNeta` filter belongs at the device-fetch layer** — AppNeta MPs (names containing `vk35` or `appneta`, case-insensitive) are synthetic probes, not real devices.

## Query patterns

### Fetch tunnels for a known device set, with latest metric inline

```js
const srcFilter = deviceIds.map((id) => `SourceDeviceID eq ${id}`).join(' or ')
const dstFilter = deviceIds.map((id) => `DestinationDeviceID eq ${id}`).join(' or ')

const url =
  '/pc/odata4/api/sdntunnels' +
  `?$filter=(${srcFilter}) and (${dstFilter})` +
  '&$expand=sdntunnelmfs($orderby=Timestamp desc;$top=1)' +
  `&starttime=${now - 3600}` +
  `&endtime=${now}` +
  '&resolution=RATE' +
  `&$top=5000` +   // ← critical: see Pitfall 1
  '&$format=application/json'
```

A `Map` of `device.id → device` makes the rendering side trivial. **Both endpoints in the visible device set** is the cleanest filter — `(SourceDeviceID in S) and (DestinationDeviceID in S)`. Devices not in S (e.g. controllers without geo coords, or not in the dashboard's group) result in tunnels being filtered out before they reach the browser.

### Per-site averages for a legend

Walk every tunnel, accumulate sum + count per `(deviceId, metric)` for both `sourceId` and `destId`. Skip devices missing from the map. See `src/components/TunnelLegend.jsx` for the canonical implementation.

## Pitfalls (each one cost a deploy cycle)

### 1. OData pagination — must set `$top` explicitly

PC's OData server applies a default page cap (~100 rows) if no `$top` is given. Symptom: most tunnels render, but the ones with the highest `ID` values silently drop. In our case Seattle had IDs in the `9794xx` range, beyond the first page — so Seattle→NY / Seattle→Atlanta lines never drew while Controller-01 → * lines (low IDs) did. **Always set `$top` to a value safely above your expected row count.** Make it config-driven.

### 2. Open metric buckets show garbage uptime values

`sdntunnelmfs` is bucketed by `Resolution` (commonly 600 = 10 min, 900 = 15 min). Within the **currently-open bucket** the cumulative-style aggregates (notably `im_PctTimeinUpState`) read as `0.0` while rolling instantaneous fields (`im_Latency`, `im_Jitter`, `im_PacketLossPercentage`) are real. The bucket closes a few minutes later and uptime jumps to its real value.

**Implication:** don't classify health by uptime. Use packet loss + latency, which are valid in-bucket. Our `healthFor` rule looks at PL + latency + jitter — never uptime. (We also dropped Uptime from the popup; latency=89ms with uptime=0% in the same record is too contradictory to display.)

### 3. Inner `$expand` options need semicolons, not commas

OData v4 inner query options inside `$expand(...)` are **semicolon-separated**, not comma-separated:

```
$expand=sdntunnelmfs($orderby=Timestamp desc;$top=1)   ✓ works
$expand=sdntunnelmfs($orderby=Timestamp desc,$top=1)   ✗ silent failure on Olingo
```

The top-level `$filter`, `$top` etc. are still comma-separated (well, `&`-separated query params). Easy to mix up.

### 4. URL spaces matter

`?$orderby=Timestamp desc` works from fetch (the API handles the literal space), but if a user copies the URL into a browser address bar the browser eats the space and OData barfs with `Unknown property 'Timestampdesc'`. Use `%20` for any URL you paste into a doc or instructions for users.

### 5. Force JSON, twice

Browser default `Accept` is HTML/XML, and PC's OData returns Atom-XML by default. Set **both**:
- `&$format=application/json` in the URL
- `Accept: application/json` header on the fetch

Either alone may work depending on PC version; both is bulletproof.

### 6. Tunnel naming varies by vendor — parse defensively

| Vendor | Tunnel `Name` shape | Example |
|---|---|---|
| Viptela | `<srcIP>-<srcTransport>-<destIP>-<destTransport>` | `172.16.240.103-public-internet-172.16.240.101-public-internet` |
| Versa | `Versa-Root-<srcSite>-<srcISP>-<destSite>-<destISP>` | `Versa-Root-FlexVNF-002-Seattle-ISP-1-Controller-01-ISP-1` |

If you try to parse the Viptela shape on a Versa name (or vice-versa) you'll get garbage. Match defensively (regex anchored on `\d+\.\d+\.\d+\.\d+`) and **return `null` transport when nothing matches** — the popup should hide the row rather than render `? → ?`.

### 7. Don't trust Spectrum for SD-WAN topology

Reflex is to reach for Spectrum's `/connectivity/<ip>` since it's the venerable topology API. **Don't** — for SD-WAN devices it returns empty, and the per-port `Gen_IF_Port` models have no health attributes. Default to PC OData for anything topology- or port-related. (Spectrum is still right for device-level alarms.) See the `pc-odata-entities` memory for the full entity-set inventory.

### 8. `lookbackSeconds` controls coverage, not freshness — auto-refresh instead

When the user wants fresher data ("catch the spikes"), the instinct is to shrink `starttime` / `endtime`. **Wrong move** — it makes links go gray, not fresh.

The `$expand=sdntunnelmfs($orderby=Timestamp desc;$top=1)` pattern already returns the **most recent** sample per tunnel, regardless of how wide the window is. Window width controls **coverage**: if a tunnel's last bucket closed before the window's start, the expand returns empty → the tunnel renders as "unknown" (gray). Bucket cycles in dev-netops are typically 10–15 min, so:

- Lookback ≤ 5 min → almost every tunnel gray (no closed bucket inside the window)
- Lookback ≤ 20 min → partial gray (only tunnels whose buckets closed in the last 20 min)
- Lookback ≥ 30 min → full coverage, expand returns the latest sample for each tunnel

**To get fresher data, re-poll on a short interval — keep lookback generous.** Auto-refresh every 60s with `setInterval`; keep `lookbackSeconds` at 3600 (1 hr) for safety. Each poll picks up new bucket closures as they happen, without sacrificing coverage.

```js
const timer = setInterval(load, config.tunnels.refreshIntervalMs)
return () => clearInterval(timer)
```

## Visualization patterns

### Group by directed pair, render one polyline per direction

`pairKey(t) = `${t.sourceId}-${t.destId}`` — directed, not undirected. This produces N lines per device pair (typically 8 for fully-meshed Viptela: 4 ISP combos × 2 directions). Matches the SDWAN dashboard's visual density. Undirected grouping (`min/max(src,dst)`) collapses everything to one line per pair — cleaner but doesn't match the SDWAN reference.

### Bezier-curve bow for overlap

Multiple polylines between geographically-clustered endpoints (Controller-01 at San Jose + FlexVNF-003-SanFrancisco — only ~50 km apart) overlap into one visual line. Fix: bow each polyline with a perpendicular midpoint offset whose **sign comes from a hash of the pair-key**. Same-pair polylines fan out symmetrically; unique pairs don't visibly curve.

```js
const controlMag = curveMagnitude * hashStr(pairKey)  // sized in lat/lon degrees
```

Tuning (externalize via `tunnels.curveMagnitude`): `0.15` subtle (matches SDWAN), `0.4` clearly separated, `0.6` visibly bowed, `0.9` pronounced (the WeatherMap default — picked when pair-line separation was prioritized over SDWAN visual match), `2.5` "diagnostic rainbow." Use **20 bezier segments** for smooth curves at all zoom levels — 10 segments looks angular.

### Popup lists every sub-tunnel in the pair

Click a polyline → popup shows the pair header + **every individual tunnel record** for that pair (name + jitter/latency/loss). Without this you only see one tunnel's metrics when there might be 4–8 underneath.

### 4-band SDWAN thresholds, color by worst metric

SDWAN dashboard uses `[greenMax, yellowMax, orangeMax]` per metric — values above `orangeMax` are red:

| Metric | Green | Yellow | Orange | Red |
|---|---|---|---|---|
| Packet Loss % | 0–3 | 3–4 | 4–5 | >5 |
| Latency (ms) | 0–100 | 100–300 | 300–500 | >500 |
| Jitter (ms) | 0–100 | 100–200 | 200–300 | >300 |

Color the polyline by the **worst level across all sub-tunnels in the group** AND across the three metrics. Externalize thresholds in `runtime-config.json` so the customer can tune without a rebuild.

### Don't let popups hide your lines during testing

Open Leaflet popups render above the map layers. If you click a marker and the popup covers half the map, lines that originate at that marker get visually occluded — easy to mistake for "lines missing." Close the popup before counting lines.

## What's in `pc_odata_entities` memory

The companion memory dumps the full entity-set list and confirms which fields are populated. Read it first when designing a new feature off PC OData rather than re-probing — many entities (`portmfs`, `interfaces.{AdminStatus,OperStatus,SpeedIn,SpeedOut}`, `sdntunnels`, etc.) already have known schemas verified live.
