import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import { matchDevices, markerKey } from '../lib/device-search.js'

/**
 * "Find device…" box: matches the devices and gateways drawn on the map by
 * name or IP (src/lib/device-search.js). Picking a hit zooms to its marker,
 * opening the cluster it sits in if needed, and opens its popup.
 *
 * Mounted as a real Leaflet control (top-left, under the zoom buttons) so it
 * never overlaps the status banner on a narrow dashboard tile, and so clicks
 * and wheel scrolls on it don't pan or zoom the map underneath.
 *
 * `markers` is a ref to a Map of markerKey → Leaflet marker, filled in by
 * DeviceMarker; `clusterRef` is the device MarkerClusterGroup.
 */
export default function DeviceSearch({ devices, markers, clusterRef }) {
  const map = useMap()
  const [container, setContainer] = useState(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const control = L.control({ position: 'topleft' })
    control.onAdd = () => {
      const div = L.DomUtil.create('div', 'leaflet-control map-search')
      L.DomEvent.disableClickPropagation(div)
      L.DomEvent.disableScrollPropagation(div)
      return div
    }
    control.addTo(map)
    setContainer(control.getContainer())
    return () => {
      control.remove()
    }
  }, [map])

  const matches = matchDevices(devices, query)
  const show = open && query.trim() !== ''

  const pick = (device) => {
    setQuery('')
    setOpen(false)
    const marker = markers.current.get(markerKey(device))
    if (!marker) return
    const cluster = clusterRef.current
    if (cluster && cluster.hasLayer(marker)) {
      cluster.zoomToShowLayer(marker, () => marker.openPopup())
    } else {
      map.setView(marker.getLatLng(), Math.max(map.getZoom(), 10))
      marker.openPopup()
    }
  }

  if (!container) return null
  return createPortal(
    <>
      <input
        className="map-search-input"
        type="search"
        value={query}
        placeholder="Find device…"
        aria-label="Find a device by name or IP"
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        // A click on a hit must land before the blur closes the list.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches.length) pick(matches[0])
          if (e.key === 'Escape') {
            setQuery('')
            setOpen(false)
          }
        }}
      />
      {show && (
        <div className="map-search-results">
          {matches.length === 0 && <div className="map-search-none">No device on the map matches</div>}
          {matches.map((d) => (
            <button key={markerKey(d)} type="button" className="map-search-hit" onClick={() => pick(d)}>
              <span className="map-search-name">{d.name}</span>
              {d.gateway && <span className="map-search-tag">gateway</span>}
              {d.ip && <span className="map-search-ip">{d.ip}</span>}
            </button>
          ))}
        </div>
      )}
    </>,
    container,
  )
}
