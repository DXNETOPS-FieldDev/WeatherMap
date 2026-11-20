/**
 * Small geometry helpers shared by the map layers that correlate devices with
 * areas (Power Outages, Wildfires). Coordinates are GeoJSON order: [lon, lat].
 */

/** [minLon, minLat, maxLon, maxLat] of any GeoJSON coordinate array. */
export function computeBbox(coords) {
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

/** True when [lon, lat] lies inside a GeoJSON Polygon or MultiPolygon. */
export function pointInGeometry(pt, geom) {
  if (geom.type === 'Polygon') return pointInPolygon(pt, geom.coordinates)
  if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      if (pointInPolygon(pt, poly)) return true
    }
  }
  return false
}

const EARTH_RADIUS_MI = 3958.8
const MILES_PER_DEG = (Math.PI * EARTH_RADIUS_MI) / 180   // ≈ 69.09 mi per degree of latitude
const rad = (d) => (d * Math.PI) / 180

/** Great-circle distance in miles between two [lon, lat] points. */
export function haversineMiles([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1)
  const dLon = rad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * Miles from [lon, lat] to a GeoJSON Point, Polygon or MultiPolygon: 0 inside a polygon, otherwise to its
 * nearest edge. Edges are measured in a flat projection centred on the point, which is accurate to well under
 * 1% at the tens of miles this is used for. Returns Infinity for a geometry it can't read.
 */
export function distanceToGeometryMiles(pt, geom) {
  if (!geom || !geom.coordinates) return Infinity
  if (geom.type === 'Point') return haversineMiles(pt, geom.coordinates)
  if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') return Infinity
  if (pointInGeometry(pt, geom)) return 0
  const [lon0, lat0] = pt
  const kx = MILES_PER_DEG * Math.cos(rad(lat0))
  const xy = ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * MILES_PER_DEG]
  let best = Infinity
  const polygons = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i++) {
        const d = distanceToSegment(xy(ring[i - 1]), xy(ring[i]))
        if (d < best) best = d
      }
    }
  }
  return best
}

// Distance from the origin (the device, after projection) to segment a–b.
function distanceToSegment([ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
  return Math.hypot(ax + t * dx, ay + t * dy)
}
