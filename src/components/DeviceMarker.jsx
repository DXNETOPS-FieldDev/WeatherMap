import { useMemo } from 'react'
import { Marker } from 'react-leaflet'
import L from 'leaflet'
import { topSeverity } from '../api/spectrum.js'
import TabbedPopup from './TabbedPopup.jsx'

// Marker color follows the most-severe alarm on the device. Devices with
// no actionable alarms get the "Normal" green.
const SEVERITY_COLOR = {
  Critical: '#d32f2f',
  Major: '#f57c00',
  Minor: '#fbc02d',
  Initial: '#1976d2',
}
const NORMAL_COLOR = '#388e3c'

const iconCache = new Map()

function getIcon(color, severity) {
  const key = `${color}|${severity}`
  if (!iconCache.has(key)) {
    iconCache.set(
      key,
      L.divIcon({
        className: 'device-marker',
        html:
          `<div class="device-marker-dot" style="background:${color}" ` +
          `data-severity="${severity}"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
        popupAnchor: [0, -9],
      }),
    )
  }
  return iconCache.get(key)
}

export default function DeviceMarker({ device, weatherApiKey }) {
  const icon = useMemo(() => {
    const top = topSeverity(device.alarms)
    const color = SEVERITY_COLOR[top] || NORMAL_COLOR
    return getIcon(color, top || 'Normal')
  }, [device.alarms])

  return (
    <Marker position={[device.latitude, device.longitude]} icon={icon}>
      <TabbedPopup device={device} apiKey={weatherApiKey} />
    </Marker>
  )
}
