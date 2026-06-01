import { GeoJSON } from 'react-leaflet'

// Color buckets aligned with the existing device-severity palette so the
// map stays visually coherent — larger outage = "more critical" color.
const SEVERITY_BUCKETS = [
  { min: 1000, color: '#7f0000', label: 'Critical (1000+ meters)' },
  { min: 100,  color: '#d32f2f', label: 'Major (100-999)' },
  { min: 10,   color: '#f57c00', label: 'Moderate (10-99)' },
  { min: 1,    color: '#fbc02d', label: 'Minor (1-9)' },
]
const UNKNOWN_COLOR = '#9e9e9e'

function colorFor(meters) {
  for (const bucket of SEVERITY_BUCKETS) {
    if (meters >= bucket.min) return bucket.color
  }
  return UNKNOWN_COLOR
}

function styleFeature(feature) {
  const meters = feature.properties.metersaffected || 0
  const color = colorFor(meters)
  return {
    color,
    weight: 1.5,
    opacity: 0.9,
    fillColor: color,
    fillOpacity: 0.35,
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function formatDateOrNull(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString()
}

// "awaitingCrewAssignment" → "Awaiting Crew Assignment". Idempotent for
// already-spaced values like "Crew Assessing".
function humanize(s) {
  if (!s) return s
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
}

function popupHtml(p) {
  const lines = [
    `<strong>${escapeHtml(p.name?.split(',')[0] || 'Unknown utility')}</strong>`,
    `${escapeHtml([p.county, p.state].filter(Boolean).join(', ') || '—')}`,
    `<strong>${(p.metersaffected || 0).toLocaleString()}</strong> meters affected`,
  ]
  const status = humanize(p.statuskind)
  if (status) lines.push(`<small>Status: ${escapeHtml(status)}</small>`)
  const cause = humanize(p.cause)
  if (cause) lines.push(`<small>Cause: ${escapeHtml(cause)}</small>`)
  const started = formatDateOrNull(p.reportedstarttime)
  if (started) lines.push(`<small>Started: ${started}</small>`)
  const etr = formatDateOrNull(p.estimatedrestorationtime)
  if (etr) lines.push(`<small>ETR: ${etr}</small>`)
  return `<div class="outage-popup">${lines.join('<br>')}</div>`
}

function onEachFeature(feature, layer) {
  layer.bindPopup(popupHtml(feature.properties))
}

/**
 * Renders ODIN outage records as a GeoJSON polygon overlay. Records without
 * usable geometry (rare) are skipped silently.
 */
export default function PowerOutageLayer({ outages }) {
  if (!outages || outages.length === 0) return null

  // ODIN's `geom` is a GeoJSON Feature wrapping a (Multi)Polygon. We rebuild
  // a clean FeatureCollection with only the properties the popup needs, so
  // styling and onEachFeature work uniformly.
  const features = []
  for (const o of outages) {
    const g = o.geom?.type === 'Feature' ? o.geom.geometry : o.geom
    if (!g || !g.type || !g.coordinates) continue
    features.push({
      type: 'Feature',
      geometry: g,
      properties: {
        name: o.name,
        county: o.county,
        state: o.state,
        metersaffected: o.metersaffected,
        statuskind: o.statuskind,
        estimatedrestorationtime: o.estimatedrestorationtime,
        cause: o.cause,
        reportedstarttime: o.reportedstarttime,
        utility_id: o.utility_id,
      },
    })
  }
  if (features.length === 0) return null

  // `key` forces remount when the feature set changes — react-leaflet's
  // GeoJSON doesn't diff `data` after initial mount.
  return (
    <GeoJSON
      key={features.length}
      data={{ type: 'FeatureCollection', features }}
      style={styleFeature}
      onEachFeature={onEachFeature}
    />
  )
}
