/**
 * Active Canadian wildfires from CWFIS (Natural Resources Canada's Canadian Wildland Fire Information System):
 * the national active-fires layer, merged from the provinces, territories and Parks Canada. Free (Open
 * Government Licence – Canada), no key, CORS-enabled — called directly from the browser, like NIFC.
 *
 * One point per fire, with its size in hectares and stage of control. No perimeters, so a Canadian fire can
 * only flag a device as "nearby" (wildfires.nearbyMiles > 0). Prescribed burns are in a separate layer and
 * never appear in this one (0 of 190,472 records, 2026-11-23).
 *
 * Only fires updated in the last 30 days are shown. Most "current" records are fires the agencies only
 * monitor and never close: on 2026-11-23, 66 of 90 had not been updated in over 90 days (some since 2020).
 * Calling those an "active wildfire" near a site would mislead the operator.
 */

const LAYER = 'public:cwfif_national_activefires'
const PAGE_SIZE = 5000   // the server returns at most 10,000 per request (2026-11-23)
const ACRES_PER_HECTARE = 2.4710538
const MAX_AGE_MS = 30 * 24 * 3600 * 1000

const STAGES = { OC: 'Out of control', BH: 'Being held', UC: 'Under control' }
const AGENCY_NAMES = { PC: 'Parks Canada' }

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const time = (s) => {
  const t = typeof s === 'string' ? Date.parse(s) : NaN
  return Number.isFinite(t) ? t : null
}
const featuresOf = (resp) => (Array.isArray(resp?.features) ? resp.features : [])

/** CWFIS GeoJSON → fires in the shape NIFC fires use, plus `source`, `hectares` and `stage`. */
export function parseCanadaFires(resp) {
  const fires = []
  for (const f of featuresOf(resp)) {
    const p = f?.properties || {}
    const c = f?.geometry?.type === 'Point' ? f.geometry.coordinates : null
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue
    const hectares = num(p.fire_size)
    const contained = num(p.percent_contained)
    fires.push({
      id: `cwfis-${p.national_fire_id || p.id || fires.length}`,
      source: 'CWFIS',
      name: p.agency_fire_id ? `Fire ${p.agency_fire_id}` : 'Unnamed fire',
      state: AGENCY_NAMES[p.agency_code] || p.agency_code || null,
      hectares,
      acres: hectares === null ? null : hectares * ACRES_PER_HECTARE,
      contained: contained === null || contained < 0 ? null : contained,
      stage: STAGES[p.stage_of_control_status] || null,
      discoveredAt: null,
      updatedAt: time(p.status_date),
      perimeter: null,
      point: [c[0], c[1]],
    })
  }
  return fires
}

/** Fires whose agency updated them within the last 30 days; a fire with no update date is left out. */
export function recentCanadaFires(fires, nowMs) {
  return fires.filter((f) => f.updatedAt !== null && nowMs - f.updatedAt <= MAX_AGE_MS)
}

/** One page of the layer: only the records current at `now` (without the filter: the whole history). */
export function canadaQueryUrl(baseUrl, now, startIndex, count) {
  const t = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const q = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: LAYER,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
    CQL_FILTER: `record_start<='${t}' AND record_end>'${t}'`,
    sortBy: 'id',
    startIndex: String(startIndex),
    count: String(count),
  })
  return `${baseUrl}?${q}`
}

/** Current Canadian fires updated in the last 30 days, paging until `numberMatched` (or an empty page, or `maxPages`). */
export async function fetchCanadaFires(baseUrl, fetchImpl = fetch, now = new Date(), { pageSize = PAGE_SIZE, maxPages = 10 } = {}) {
  const features = []
  for (let page = 0; page < maxPages; page++) {
    const response = await fetchImpl(canadaQueryUrl(baseUrl, now, features.length, pageSize))
    if (!response.ok) throw new Error(`CWFIS fetch failed: HTTP ${response.status}`)
    const data = await response.json()
    const got = featuresOf(data)
    features.push(...got)
    const matched = num(data?.numberMatched)
    if (got.length === 0 || matched === null || features.length >= matched) break
  }
  return recentCanadaFires(parseCanadaFires({ features }), now.getTime())
}
