/**
 * Active US wildfires from NIFC's WFIGS services (National Interagency Fire Center): current fire
 * perimeters (polygons) and current incident locations (points). Free, no key, CORS-enabled — called
 * directly from the browser, like the ODIN power-outage feed.
 *
 * Only wildfires are kept: IncidentTypeCategory WF (wildfire) and CX (complex of wildfires). RX (prescribed
 * burns) is left out — it is most of the incident feed and is planned, not a threat.
 *
 * A perimeter and its incident are the same fire when their IRWIN ids match (the ids come with braces and in
 * upper case in both services; matching ignores both).
 */

import { getConfig } from '../lib/config.js'
import { computeBbox, pointInGeometry, distanceToGeometryMiles } from '../lib/geo.js'

const WILDFIRE_TYPES = ['WF', 'CX']
const PAGE_SIZE = 2000   // both services' maxRecordCount (2026-11-20)

const PERIMETER_FIELDS = [
  'poly_IncidentName', 'poly_GISAcres', 'poly_DateCurrent', 'attr_POOState', 'attr_PercentContained',
  'attr_IncidentTypeCategory', 'attr_FireDiscoveryDateTime', 'attr_IrwinID',
].join(',')
const INCIDENT_FIELDS = [
  'IrwinID', 'IncidentName', 'IncidentSize', 'PercentContained', 'FireDiscoveryDateTime',
  'ModifiedOnDateTime_dt', 'POOState', 'IncidentTypeCategory',
].join(',')

const typeFilter = (field) => `${field} IN (${WILDFIRE_TYPES.map((t) => `'${t}'`).join(',')})`
const normId = (s) => (typeof s === 'string' ? s.replace(/[{}]/g, '').trim().toLowerCase() : '')
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const state = (s) => (typeof s === 'string' && s ? s.replace(/^US-/, '') : null)
const maxOrNull = (...vals) => {
  const n = vals.filter((v) => v !== null)
  return n.length ? Math.max(...n) : null
}
const featuresOf = (resp) => (Array.isArray(resp?.features) ? resp.features : [])
const isWildfire = (t) => WILDFIRE_TYPES.includes(t)

/**
 * Merge the two NIFC responses (GeoJSON FeatureCollections) into one list of fires:
 * `{ id, name, state, acres, contained, discoveredAt, updatedAt, perimeter, point }`.
 * `perimeter` is a (Multi)Polygon or null; `point` is [lon, lat] or null. Numbers NIFC leaves empty stay null.
 */
export function parseWildfires(perimeterResp, incidentResp) {
  const fires = new Map()
  for (const f of featuresOf(incidentResp)) {
    const p = f?.properties || {}
    if (!isWildfire(p.IncidentTypeCategory)) continue
    const id = normId(p.IrwinID)
    const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : null
    fires.set(id || `incident-${fires.size}`, {
      id: id || `incident-${fires.size}`,
      name: p.IncidentName || 'Unnamed fire',
      state: state(p.POOState),
      acres: num(p.IncidentSize),
      contained: num(p.PercentContained),
      discoveredAt: num(p.FireDiscoveryDateTime),
      updatedAt: num(p.ModifiedOnDateTime_dt),
      perimeter: null,
      point: Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? [c[0], c[1]] : null,
    })
  }
  for (const f of featuresOf(perimeterResp)) {
    const p = f?.properties || {}
    const g = f?.geometry
    if (!isWildfire(p.attr_IncidentTypeCategory)) continue
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon') || !Array.isArray(g.coordinates)) continue
    const id = normId(p.attr_IrwinID) || `perimeter-${fires.size}`
    const known = fires.get(id)
    fires.set(id, {
      id,
      // The perimeter's name and mapped acres are the better record (proper casing; measured area).
      name: p.poly_IncidentName || known?.name || 'Unnamed fire',
      state: state(p.attr_POOState) ?? known?.state ?? null,
      acres: num(p.poly_GISAcres) ?? known?.acres ?? null,
      contained: num(p.attr_PercentContained) ?? known?.contained ?? null,
      discoveredAt: num(p.attr_FireDiscoveryDateTime) ?? known?.discoveredAt ?? null,
      updatedAt: maxOrNull(num(p.poly_DateCurrent), known?.updatedAt ?? null),
      perimeter: g,
      point: known?.point ?? null,
    })
  }
  return [...fires.values()]
}

/**
 * For each device, the wildfire that affects it: Map<deviceId, { fire, kind, miles }>.
 * - kind "inside": the device is inside a fire perimeter (miles 0). Same containment test as Power Outages.
 * - kind "nearby": only when nearbyMiles > 0 — the nearest fire within that many miles, measured to the
 *   perimeter's edge, or to the incident point for a fire with no perimeter yet.
 * Inside beats nearby; a nearer fire beats a farther one. Devices not affected are absent.
 */
export function correlateWildfiresToDevices(devices, fires, nearbyMiles) {
  const radius = typeof nearbyMiles === 'number' && Number.isFinite(nearbyMiles) && nearbyMiles > 0 ? nearbyMiles : 0
  const indexed = (Array.isArray(fires) ? fires : []).map((fire) => ({
    fire,
    bbox: fire.perimeter ? computeBbox(fire.perimeter.coordinates) : null,
  }))
  const result = new Map()
  for (const d of Array.isArray(devices) ? devices : []) {
    if (!Number.isFinite(d?.longitude) || !Number.isFinite(d?.latitude)) continue
    const pt = [d.longitude, d.latitude]
    let best = null
    for (const { fire, bbox } of indexed) {
      if (fire.perimeter) {
        const inBox = pt[0] >= bbox[0] && pt[0] <= bbox[2] && pt[1] >= bbox[1] && pt[1] <= bbox[3]
        if (inBox && pointInGeometry(pt, fire.perimeter)) {
          best = { fire, kind: 'inside', miles: 0 }
          break
        }
      }
      if (!radius) continue
      if (fire.perimeter && !nearBox(pt, bbox, radius)) continue
      const geom = fire.perimeter || (fire.point ? { type: 'Point', coordinates: fire.point } : null)
      if (!geom) continue
      const miles = distanceToGeometryMiles(pt, geom)
      if (miles <= radius && (!best || miles < best.miles)) best = { fire, kind: 'nearby', miles }
    }
    if (best) result.set(d.id, best)
  }
  return result
}

// Cheap reject: is the point within `miles` of the bbox (degrees widened by the radius, generously)?
function nearBox([lon, lat], [minX, minY, maxX, maxY], miles) {
  const dLat = miles / 69
  const dLon = miles / (69 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)))
  return lon >= minX - dLon && lon <= maxX + dLon && lat >= minY - dLat && lat <= maxY + dLat
}

/** Distinct fires shown in device banners — what the "Wildfires (N)" label counts (like Power Outages). */
export function bannerFireCount(devices) {
  const shown = new Set()
  for (const d of Array.isArray(devices) ? devices : []) {
    if (d?.wildfire?.fire) shown.add(d.wildfire.fire.id ?? d.wildfire.fire)
  }
  return shown.size
}

/**
 * GET every page of an ArcGIS FeatureServer query as GeoJSON. A page that doesn't hold everything carries
 * `properties.exceededTransferLimit: true`; the next one starts at resultOffset += features on this page.
 * Throws on an HTTP error. `maxPages` caps a server that never stops saying "more".
 */
export async function fetchAllPages(url, params, fetchImpl = fetch, { maxPages = 20, pageSize = PAGE_SIZE } = {}) {
  const all = []
  let offset = 0
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ ...params, f: 'geojson', resultOffset: String(offset), resultRecordCount: String(pageSize) })
    const response = await fetchImpl(`${url}?${q}`)
    if (!response.ok) throw new Error(`NIFC fetch failed: HTTP ${response.status}`)
    const data = await response.json()
    const features = featuresOf(data)
    all.push(...features)
    if (!data?.properties?.exceededTransferLimit || features.length === 0) break
    offset += features.length
  }
  return all
}

/** Fetch and merge both NIFC feeds. Resolves to [] when the wildfires settings are absent. */
export async function fetchWildfires() {
  const cfg = getConfig().wildfires
  if (!cfg?.perimetersUrl || !cfg?.incidentsUrl) return []
  const [perimeters, incidents] = await Promise.all([
    fetchAllPages(cfg.perimetersUrl, {
      where: typeFilter('attr_IncidentTypeCategory'),
      outFields: PERIMETER_FIELDS,
      geometryPrecision: '4',
      maxAllowableOffset: '0.002',
      outSR: '4326',
    }),
    fetchAllPages(cfg.incidentsUrl, {
      where: typeFilter('IncidentTypeCategory'),
      outFields: INCIDENT_FIELDS,
      outSR: '4326',
    }),
  ])
  return parseWildfires({ features: perimeters }, { features: incidents })
}

const shortDate = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

/**
 * Display text for a fire, shared by the device banner and the map popup:
 * `{ title, size, dates }`, where size and dates are null when NIFC has none of their numbers
 * (unknown is left out, never shown as 0).
 */
export function fireFacts(fire) {
  const title = fire.state ? `${fire.name} (${fire.state})` : fire.name
  const parts = []
  if (fire.acres !== null && fire.acres !== undefined) {
    parts.push(fire.acres < 1 ? 'less than 1 acre' : `${Math.round(fire.acres).toLocaleString('en-US')} acres`)
  }
  if (fire.contained !== null && fire.contained !== undefined) parts.push(`${fire.contained}% contained`)
  const d = []
  if (fire.discoveredAt) d.push(`Discovered ${shortDate(fire.discoveredAt)}`)
  if (fire.updatedAt) d.push(`${d.length ? 'updated' : 'Updated'} ${shortDate(fire.updatedAt)}`)
  return { title, size: parts.length ? parts.join(' · ') : null, dates: d.length ? d.join(' · ') : null }
}

/** "less than 1 mi" / "about 8 mi". */
export function distanceText(miles) {
  return miles < 1 ? 'less than 1 mi' : `about ${Math.round(miles)} mi`
}
