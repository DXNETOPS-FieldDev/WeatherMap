import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import '../lib/leaflet.rainviewer.js'

/**
 * Adds the Rainviewer animated radar control to the Leaflet map.
 *
 * The plugin extends L.Control, so it's a Leaflet-native widget rather than a
 * React component. We mount it imperatively in a useEffect: instantiate the
 * control, addTo() the map, and on cleanup, removeFrom() the map.
 *
 * The control adds itself to the bottom-left by default. The radar overlay
 * starts hidden — the user clicks Play to begin the animation.
 *
 * Draggable by the "Weather Radar" title button — L.Draggable lets clicks
 * without movement pass through to the plugin's own expand/collapse handler.
 * Drag position persists across effect runs via positionRef.
 *
 * Requires the portal CSP to allow:
 *   - https://api.rainviewer.com   in connect-src
 *   - https://tilecache.rainviewer.com   in img-src
 */
export default function RainviewerControl() {
  const map = useMap()
  const positionRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const control = new L.Control.Rainviewer({
      position: 'bottomleft',
      nextButtonText: '>',
      playStopButtonText: 'Play/Stop',
      prevButtonText: '<',
      positionSliderLabelText: 'Hour:',
      opacitySliderLabelText: 'Opacity:',
      animationInterval: 500,
      opacity: 0.5,
    })

    control.addTo(map)

    const container = control.getContainer()
    const dragHandle = container.querySelector('.leaflet-control-rainviewer-button')
    let draggable
    let suppressClick

    if (dragHandle) {
      let justDragged = false
      draggable = new L.Draggable(container, dragHandle)
      draggable.enable()
      draggable.on('drag', () => {
        justDragged = true
        L.DomUtil.setPosition(container, draggable._newPos)
        positionRef.current = { x: draggable._newPos.x, y: draggable._newPos.y }
      })
      draggable.on('dragend', () => {
        // Keep the flag set briefly so the post-mouseup click on the title
        // (which would otherwise fire the plugin's stop+collapse handler)
        // gets suppressed. Reset on a short timer so normal clicks work.
        setTimeout(() => { justDragged = false }, 50)
      })
      if (positionRef.current.x || positionRef.current.y) {
        L.DomUtil.setPosition(container, positionRef.current)
      }

      // Capture-phase listener fires before the plugin's bubble-phase
      // handler, so stopImmediatePropagation cancels the toggle.
      suppressClick = (e) => {
        if (justDragged) {
          e.stopImmediatePropagation()
          e.preventDefault()
        }
      }
      dragHandle.addEventListener('click', suppressClick, true)
    }

    return () => {
      if (draggable) draggable.disable()
      if (dragHandle && suppressClick) {
        dragHandle.removeEventListener('click', suppressClick, true)
      }
      control.remove()
    }
  }, [map])

  return null
}
