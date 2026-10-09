import { getConfig } from '../lib/config.js'

// Set once, the first time the OData schema turns out not to expose tunnel
// metrics (older/other PC versions don't have this navigation property) —
// remembered for the rest of the session so we stop retrying a query we
// already know will fail, and so the UI can tell the user why tunnels are
// rendering without jitter/latency/loss coloring.
let metricsUnavailable = false
let missingMetricsProperty = null

// Device ids per tunnel request. Performance Center rejects a long query
// string with HTTP 400 (a 7,099-character URL for 89 devices failed), so the
// device list is split; 40 ids keep each URL around 1.5 KB.
const SOURCE_IDS_PER_REQUEST = 40

/** `$filter` values selecting tunnels by source device, `perRequest` ids each. */
export function tunnelSourceFilters(deviceIds, perRequest = SOURCE_IDS_PER_REQUEST) {
  const filters = []
  for (let i = 0; i < deviceIds.length; i += perRequest) {
    filters.push(deviceIds.slice(i, i + perRequest).map((id) => `SourceDeviceID eq ${id}`).join(' or '))
  }
  return filters
}

export function getTunnelMetricsStatus() {
  return { unavailable: metricsUnavailable, missingProperty: missingMetricsProperty }
}

/**
 * Fetch SD-WAN tunnels whose source AND destination devices are both in our
 * visible device set, with the latest 10-minute metric sample inline. Large
 * device sets are fetched in several requests (see SOURCE_IDS_PER_REQUEST).
 *
 * Returns normalized tunnels: { id, name, sourceId, destId, transport, latency,
 * jitter, packetLoss, uptimePct }.
 *
 * Debug mode returns []; there's no sample tunnel data.
 */
export async function fetchTunnels(deviceIds, { debug } = {}) {
  if (debug || deviceIds.length === 0) return []

  const onMap = new Set(deviceIds)
  const pages = await Promise.all(tunnelSourceFilters(deviceIds).map(fetchTunnelRows))
  // Each request selects by source only; a tunnel counts when its
  // destination is on the map too. Keyed by ID in case one comes back twice.
  const byId = new Map()
  for (const r of pages.flat()) {
    if (onMap.has(r.DestinationDeviceID)) byId.set(r.ID, r)
  }
  return [...byId.values()].map(normalize)
}

async function fetchTunnelRows(filter) {
  const cfg = getConfig().tunnels
  const now = Math.floor(Date.now() / 1000)
  const startTime = now - cfg.lookbackSeconds

  const buildUrl = (withMetrics) =>
    cfg.apiPath +
    `?$filter=${filter}` +
    (withMetrics ? '&$expand=sdntunnelmfs($orderby=Timestamp desc;$top=1)' : '') +
    `&starttime=${startTime}` +
    `&endtime=${now}` +
    '&resolution=RATE' +
    `&$top=${cfg.maxRecords}` +
    '&$format=application/json'

  let response = await fetch(buildUrl(!metricsUnavailable), { headers: { Accept: 'application/json' } })

  // The OData4 parser rejects an unsupported $expand outright (400, before
  // any rows come back) rather than just omitting the expansion — so on a
  // schema without this navigation property we have to drop $expand and
  // retry, not just tolerate missing data in the response.
  if (!response.ok && !metricsUnavailable) {
    // Olingo's error page HTML-encodes apostrophes as &#39; rather than
    // using a literal ' — decode that before matching.
    const body = (await response.text()).replace(/&#39;/g, "'")
    const match = body.match(/Navigation Property '([^']+)'\s*not found/)
    if (match) {
      metricsUnavailable = true
      missingMetricsProperty = match[1].trim()
      response = await fetch(buildUrl(false), { headers: { Accept: 'application/json' } })
    }
  }

  if (!response.ok) {
    throw new Error(`Tunnels query failed: HTTP ${response.status}`)
  }
  const data = await response.json()
  return data.value || []
}

function normalize(row) {
  const mf = row.sdntunnelmfs?.[0] || null
  return {
    id: row.ID,
    name: row.Name,
    sourceId: row.SourceDeviceID,
    destId: row.DestinationDeviceID,
    transport: parseTransport(row.Name),
    latency: mf?.im_Latency ?? null,
    jitter: mf?.im_Jitter ?? null,
    packetLoss: mf?.im_PacketLossPercentage ?? null,
  }
}

// Viptela tunnel Name shape: "<srcIP>-<srcTransport>-<destIP>-<destTransport>"
// e.g. "172.16.240.103-public-internet-172.16.240.101-public-internet".
// Other SD-WAN vendors (Versa FlexVNF, etc.) use different conventions; for
// those we just return nulls and the popup hides the transport row.
function parseTransport(name) {
  if (!name) return { src: null, dst: null }
  const m = name.match(/^(\d+\.\d+\.\d+\.\d+)-(.+?)-(\d+\.\d+\.\d+\.\d+)-(.+)$/)
  return m ? { src: m[2], dst: m[4] } : { src: null, dst: null }
}
