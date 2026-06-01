/**
 * Fetch active power outages from ODIN (Outage Data Initiative Nationwide),
 * a free DoE/Oak Ridge feed of utility-reported outages.
 *
 * No auth required, CORS-enabled — called directly from the browser.
 * The endpoint caps page size at 100, so we paginate up to maxRecords.
 *
 * `select` trims the payload to fields the UI actually uses (the dataset
 * has 20+ fields; geom alone can be several KB per record).
 */

import { getConfig } from '../lib/config.js'

const PAGE_SIZE = 100  // OpenDataSoft per-call cap

const FIELDS = [
  'name',
  'state',
  'county',
  'metersaffected',
  'statuskind',
  'estimatedrestorationtime',
  'cause',
  'reportedstarttime',
  'utility_id',
  'geom',
  'geo_point_2d',
].join(',')

/**
 * For each device, find the most-severe ODIN outage whose polygon contains
 * the device's (lon, lat). Returns Map<deviceId, outage>. Devices not inside
 * any outage are absent from the map.
 *
 * "Inside" is a polygon containment test, not proximity — only flags devices
 * whose coordinates fall within the utility's reported service area. False
 * positives still possible (polygons are coarse service-area approximations,
 * not exact street-level extents), so callers should label results as
 * "possible" not "confirmed."
 */
export function correlateOutagesToDevices(devices, outages) {
  const indexed = []
  for (const o of outages) {
    const g = o.geom?.type === 'Feature' ? o.geom.geometry : o.geom
    if (!g || !g.coordinates) continue
    indexed.push({ outage: o, geom: g, bbox: computeBbox(g.coordinates) })
  }

  const result = new Map()
  for (const d of devices) {
    if (!Number.isFinite(d.longitude) || !Number.isFinite(d.latitude)) continue
    const pt = [d.longitude, d.latitude]
    let best = null
    let bestMeters = -1
    for (const { outage, geom, bbox } of indexed) {
      if (pt[0] < bbox[0] || pt[0] > bbox[2] || pt[1] < bbox[1] || pt[1] > bbox[3]) continue
      if (!pointInGeometry(pt, geom)) continue
      const m = outage.metersaffected || 0
      if (m > bestMeters) {
        best = outage
        bestMeters = m
      }
    }
    if (best) result.set(d.id, best)
  }
  return result
}

function computeBbox(coords) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const walk = (a) => {
    if (typeof a[0] === 'number') {
      if (a[0] < minX) minX = a[0]
      if (a[0] > maxX) maxX = a[0]
      if (a[1] < minY) minY = a[1]
      if (a[1] > maxY) maxY = a[1]
    } else {
      for (const item of a) walk(item)
    }
  }
  walk(coords)
  return [minX, minY, maxX, maxY]
}

// Ray-casting point-in-ring. Ring is an array of [lon, lat] pairs.
function pointInRing([x, y], ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside
    }
  }
  return inside
}

function pointInPolygon(pt, polygon) {
  if (!pointInRing(pt, polygon[0])) return false
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(pt, polygon[i])) return false  // inside a hole
  }
  return true
}

function pointInGeometry(pt, geom) {
  if (geom.type === 'Polygon') return pointInPolygon(pt, geom.coordinates)
  if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      if (pointInPolygon(pt, poly)) return true
    }
  }
  return false
}

export async function fetchActiveOutages() {
  const { apiUrl, maxRecords } = getConfig().powerOutages
  const all = []
  let offset = 0
  while (offset < maxRecords) {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      select: FIELDS,
    })
    const response = await fetch(`${apiUrl}/records?${params}`)
    if (!response.ok) {
      throw new Error(`ODIN fetch failed: HTTP ${response.status}`)
    }
    const data = await response.json()
    const records = data.results || []
    all.push(...records)
    if (records.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return all
}
