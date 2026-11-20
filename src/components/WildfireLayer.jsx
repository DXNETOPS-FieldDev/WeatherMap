import { GeoJSON, Marker, Popup, LayerGroup, Pane } from 'react-leaflet'
import L from 'leaflet'
import { fireFacts } from '../api/wildfires.js'

// Active fires red-orange; fully contained ones muted, so the eye goes to what is still burning.
const ACTIVE = '#d84315'
const CONTAINED = '#8d6e63'
const colorFor = (fire) => (fire.contained !== null && fire.contained >= 100 ? CONTAINED : ACTIVE)

// Fires without a mapped perimeter are drawn as a small flame, never a round dot: round red/orange dots
// are how the map shows devices in alarm, and the two must not be confused.
const flameIcon = (fire) => L.divIcon({
  className: `wildfire-icon${fire.contained !== null && fire.contained >= 100 ? ' wildfire-icon-contained' : ''}`,
  html: '🔥',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
  popupAnchor: [0, -8],
})

const ATTRIBUTION = 'Wildfire data: <a href="https://www.nifc.gov/" target="_blank" rel="noopener">NIFC</a>'

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function popupHtml(fire) {
  const f = fireFacts(fire)
  const lines = [`<strong>🔥 ${escapeHtml(f.title)}</strong>`]
  if (f.size) lines.push(escapeHtml(f.size))
  if (f.dates) lines.push(`<small>${escapeHtml(f.dates)}</small>`)
  if (!fire.perimeter) lines.push('<small>No mapped perimeter yet: shown at its reported location</small>')
  lines.push('<small>Source: NIFC</small>')
  return `<div class="wildfire-popup">${lines.join('<br>')}</div>`
}

/**
 * Active US wildfires from NIFC: perimeters as polygons, and fires that have no mapped perimeter yet as
 * small markers at their reported location. Renders nothing until there is data.
 */
export default function WildfireLayer({ fires }) {
  if (!fires || fires.length === 0) return null

  const withPerimeter = fires.filter((f) => f.perimeter)
  const pointOnly = fires.filter((f) => !f.perimeter && f.point)
  const byFeature = new Map()
  const features = withPerimeter.map((fire, i) => {
    byFeature.set(i, fire)
    return { type: 'Feature', geometry: fire.perimeter, properties: { i } }
  })

  return (
    <LayerGroup attribution={ATTRIBUTION}>
      {features.length > 0 && (
        <GeoJSON
          // react-leaflet's GeoJSON doesn't diff `data`; remount when the set changes.
          key={withPerimeter.map((f) => f.id).join('|')}
          data={{ type: 'FeatureCollection', features }}
          attribution={ATTRIBUTION}
          style={(feature) => {
            const color = colorFor(byFeature.get(feature.properties.i))
            return { color, weight: 1.5, opacity: 0.9, fillColor: color, fillOpacity: 0.3 }
          }}
          onEachFeature={(feature, layer) => layer.bindPopup(popupHtml(byFeature.get(feature.properties.i)))}
        />
      )}
      {/* Below the device markers (markerPane is 600), above polygons (400): devices stay on top. */}
      <Pane name="wildfire-points" style={{ zIndex: 450 }}>
        {pointOnly.map((fire) => (
          <Marker key={fire.id} position={[fire.point[1], fire.point[0]]} icon={flameIcon(fire)}>
            <Popup>
              <div dangerouslySetInnerHTML={{ __html: popupHtml(fire) }} />
            </Popup>
          </Marker>
        ))}
      </Pane>
    </LayerGroup>
  )
}
