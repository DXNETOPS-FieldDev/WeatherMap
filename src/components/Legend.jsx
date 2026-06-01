import { useEffect, useState } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'

const SEVERITY_ITEMS = [
  { label: 'Critical',  color: '#d32f2f' },
  { label: 'Major',     color: '#f57c00' },
  { label: 'Minor',     color: '#fbc02d' },
  { label: 'Initial',   color: '#1976d2' },
  { label: 'No alarms', color: '#388e3c' },
]

/**
 * Alarm-severity legend in the map's bottom-right corner. Built as a
 * native Leaflet Control (matching RainviewerControl's pattern) so it
 * lives in the map chrome rather than the document flow.
 *
 * The × button hides the legend for the current session. To remove the
 * legend permanently, delete the <Legend /> line from App.jsx (and this
 * file).
 */
export default function Legend() {
  const map = useMap()
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    if (hidden) return

    const control = L.control({ position: 'bottomright' })
    let draggable

    control.onAdd = () => {
      const div = L.DomUtil.create('div', 'severity-legend')
      div.innerHTML =
        '<button class="legend-close" title="Hide legend" aria-label="Hide legend">×</button>' +
        '<div class="legend-title" title="Drag to move">Alarm severity</div>' +
        SEVERITY_ITEMS.map(
          (item) =>
            `<div class="legend-item">` +
              `<span class="legend-swatch" style="background:${item.color}"></span>` +
              `<span>${item.label}</span>` +
            `</div>`,
        ).join('')

      // Don't let clicks/scrolls inside the legend pan the map.
      L.DomEvent.disableClickPropagation(div)
      L.DomEvent.disableScrollPropagation(div)

      const closeBtn = div.querySelector('.legend-close')
      L.DomEvent.on(closeBtn, 'click', () => setHidden(true))

      // Drag from the title bar — clicks on color rows and the × button
      // still work normally because L.Draggable only triggers on the handle.
      const titleEl = div.querySelector('.legend-title')
      draggable = new L.Draggable(div, titleEl)
      draggable.enable()
      draggable.on('drag', () => {
        L.DomUtil.setPosition(div, draggable._newPos)
      })

      return div
    }
    control.addTo(map)
    return () => {
      if (draggable) draggable.disable()
      control.remove()
    }
  }, [map, hidden])

  return null
}
