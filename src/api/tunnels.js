import { getConfig } from '../lib/config.js'

// Set once, the first time the OData schema turns out not to expose tunnel
// metrics (older/other PC versions don't have this navigation property) —
// remembered for the rest of the session so we stop retrying a query we
// already know will fail, and so the UI can tell the user why tunnels are
// rendering without jitter/latency/loss coloring.
let metricsUnavailable = false
let missingMetricsProperty = null

export function getTunnelMetricsStatus() {
  return { unavailable: metricsUnavailable, missingProperty: missingMetricsProperty }
}

/**
 * Fetch SD-WAN tunnels whose source AND destination devices are both in our
 * visible device set, with the latest 10-minute metric sample inline.
 *
 * Returns normalized tunnels: { id, name, sourceId, destId, transport, latency,
 * jitter, packetLoss, uptimePct }.
 *
 * Debug mode returns []; there's no sample tunnel data.
 */
export async function fetchTunnels(deviceIds, { debug } = {}) {
  if (debug || deviceIds.length === 0) return []

  const cfg = getConfig().tunnels
  const now = Math.floor(Date.now() / 1000)
  const startTime = now - cfg.lookbackSeconds

  const srcFilter = deviceIds.map((id) => `SourceDeviceID eq ${id}`).join(' or ')
  const dstFilter = deviceIds.map((id) => `DestinationDeviceID eq ${id}`).join(' or ')
  const buildUrl = (withMetrics) =>
    cfg.apiPath +
    `?$filter=(${srcFilter}) and (${dstFilter})` +
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
  return (data.value || []).map(normalize)
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
