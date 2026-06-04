import Papa from 'papaparse'
import { getConfig } from '../lib/config.js'

/**
 * Fetch just the AppNeta MP devices from PC for the current group context,
 * regardless of the `includeAppNeta` flag. The main `fetchDevices()` in
 * odata.js excludes these by default so they don't clutter the SDWAN-focused
 * map view; the AppNeta layer needs them back so we can:
 *   1. Join AppNeta path inventory's `sourceAppliance` (a name) to a PC
 *      device id + geo (the line's source endpoint).
 *   2. Render MP markers on the map when the AppNeta overlay is on.
 *
 * Filters:
 *   - groups/any(L1:L1/ID eq <id>) — same group filter fetchDevices uses,
 *     so we never pull MPs from outside the user's selected group context
 *     (e.g. a Backbone-London-MP that belongs to a Global Backbone group).
 *     This also indirectly trims the AppNeta path list, because paths whose
 *     source isn't in the local pool get dropped by fetchAppNetaPaths().
 *   - Name contains vk35 / appneta / endswith -MP — covers the dev-vk35-*,
 *     vk35-*, Backbone-*-MP, RBC-*-MP, MSO-*-MP, *-AppNeta naming patterns
 *     we've seen across customer environments.
 *
 * Returns the same normalized shape as fetchDevices() — id, name,
 * latitude, longitude — so the AppNeta layer can use them interchangeably.
 */
export async function fetchAppNetaMpDevices({ id, debug } = {}) {
  if (debug || id == null) return []
  const { topLimit } = getConfig().odata
  const url =
    '/pc/odata4/api/devices' +
    '?$select=GlobalID,ID,Name,PrimaryIPAddress,Latitude,Longitude' +
    '&$filter=(Latitude ne null)' +
      ` and (groups/any(L1:L1/ID eq ${id}))` +
      " and (contains(tolower(Name),'vk35') or " +
      "contains(tolower(Name),'appneta') or " +
      "endswith(Name,'-MP'))" +
    '&$format=text/csv' +
    `&$top=${topLimit}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`AppNeta MP devices: HTTP ${response.status}`)
  const { data } = Papa.parse(await response.text(), {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  })
  return data
    .filter((row) => row.ID && row.Name && row.Latitude != null && row.Longitude != null)
    .map((row) => ({
      id: row.ID,
      globalId: row.GlobalID,
      name: row.Name,
      ip: row.PrimaryIPAddress,
      latitude: Number(row.Latitude),
      longitude: Number(row.Longitude),
    }))
}


/**
 * Fetch AppNeta Network Paths whose source MP matches a PC device by name
 * AND whose target has geo-location set (so we can draw the line on the
 * map). Inventory + bulk metric window come back in a single Promise.all.
 *
 * Returns normalized paths:
 *   { id, name, sourceName, sourceDeviceId, sourceLat, sourceLng,
 *     target, targetLat, targetLng, targetLocality,
 *     dualEnded, protocol, ispName,
 *     latency, rtt, dataLoss, dataJitter, voiceLoss, voiceJitter, mos }
 *
 * Debug mode returns []; no AppNeta sample data ships with the App View.
 *
 * The bulk `/v3/path/data?from&to` endpoint is the load-bearing efficiency
 * choice — one call per refresh regardless of path count. AppNeta's
 * developer docs lead with the per-path pattern `/v3/path/{id}/data`, but
 * that would be N calls per refresh (~125 in the dev org). Bulk is
 * confirmed working against orgId 19584; fall back to per-path if it ever
 * starts 404-ing.
 */
export async function fetchAppNetaPaths(devicesByName, { debug } = {}) {
  if (debug || devicesByName.size === 0) return []

  const cfg = getConfig().appnetaPaths
  const now = Math.floor(Date.now() / 1000)
  const from = now - cfg.lookbackSeconds

  const headers = { Accept: 'application/json' }
  const [invRes, metRes] = await Promise.all([
    fetch(`./appneta-proxy.jsp?path=${encodeURIComponent('v3/path')}`, { headers }),
    fetch(
      `./appneta-proxy.jsp?path=${encodeURIComponent('v3/path/data')}` +
        `&from=${from}&to=${now}`,
      { headers },
    ),
  ])

  if (!invRes.ok) throw new Error(`AppNeta inventory: HTTP ${invRes.status}`)
  if (!metRes.ok) throw new Error(`AppNeta metrics: HTTP ${metRes.status}`)

  const inventory = await invRes.json()
  const metricsList = await metRes.json()

  const metricsById = new Map()
  for (const m of metricsList) {
    metricsById.set(m.pathId, extractMetrics(m))
  }

  return inventory
    .filter((p) => isRenderable(p, devicesByName))
    .map((p) =>
      normalize(p, devicesByName.get(p.sourceAppliance), metricsById.get(p.id)),
    )
}

function isRenderable(path, devicesByName) {
  if (!devicesByName.has(path.sourceAppliance)) return false
  const loc = path.targetLocation
  return loc != null && loc.lat != null && loc.lng != null
}

function normalize(path, device, metrics) {
  return {
    id: path.id,
    name: path.pathName || path.name,
    sourceName: path.sourceAppliance,
    sourceDeviceId: device.id,
    sourceLat: device.latitude,
    sourceLng: device.longitude,
    target: path.target,
    targetLat: path.targetLocation.lat,
    targetLng: path.targetLocation.lng,
    targetLocality:
      path.targetLocation.locality || path.targetLocation.formattedAddress,
    // v3's `asymmetric` flag is misnamed — true means "dual-ended" (TWO_WAY
    // metric instrumentation). v4 fixed it to `dualEnded`; we use that name.
    dualEnded: !!path.asymmetric,
    protocol: path.networkProtocol,
    ispName: path.ispName,
    ...(metrics || nullMetrics()),
  }
}

function nullMetrics() {
  return {
    latency: null,
    rtt: null,
    dataLoss: null,
    dataJitter: null,
    voiceLoss: null,
    voiceJitter: null,
    mos: null,
  }
}

// TWO_WAY records carry direction-split metrics in dataInbound/dataOutbound
// plus a top-level `data` block with latency + RTT. ONE_WAY records keep
// everything in `data`. We collapse to one value per metric here so the
// layer never has to think about directions.
function extractMetrics(record) {
  const data = record.data || {}
  if (record.instrumentation === 'TWO_WAY') {
    const inb = record.dataInbound || {}
    const out = record.dataOutbound || {}
    return {
      latency: latest(data.latency),
      rtt: latest(data.rtt),
      dataLoss: worst(latest(inb.dataLoss), latest(out.dataLoss), 'max'),
      dataJitter: worst(latest(inb.dataJitter), latest(out.dataJitter), 'max'),
      voiceLoss: worst(latest(inb.voiceLoss), latest(out.voiceLoss), 'max'),
      voiceJitter: worst(latest(inb.voiceJitter), latest(out.voiceJitter), 'max'),
      mos: worst(latest(inb.mos), latest(out.mos), 'min'),
    }
  }
  return {
    latency: latest(data.latency),
    rtt: latest(data.rtt),
    dataLoss: latest(data.dataLoss),
    dataJitter: latest(data.dataJitter),
    voiceLoss: latest(data.voiceLoss),
    voiceJitter: latest(data.voiceJitter),
    mos: latest(data.mos),
  }
}

// AppNeta uses -1.0 as a sentinel for "no data in this bucket". Walk back
// from the end of the array until we find a real sample.
function latest(arr) {
  if (!Array.isArray(arr)) return null
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i]?.value
    if (v != null && v !== -1.0) return v
  }
  return null
}

function worst(a, b, kind) {
  if (a == null) return b
  if (b == null) return a
  return kind === 'max' ? Math.max(a, b) : Math.min(a, b)
}
