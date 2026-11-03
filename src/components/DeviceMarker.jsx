import { useMemo } from 'react'
import { Marker } from 'react-leaflet'
import L from 'leaflet'
import { topDeviceSeverity, topComponentSeverity } from '../api/spectrum.js'
import TabbedPopup from './TabbedPopup.jsx'

// Marker dot color follows the device's own alarm severity. A small corner
// badge is added when the device has *component* (interface) alarms — same
// visual convention as topology / OneClick: device-fine + subcomponent-issue
// reads as "green disc with a colored dot" rather than turning the whole
// marker orange.
const SEVERITY_COLOR = {
  Critical: '#d32f2f',
  Major: '#f57c00',
  Minor: '#fbc02d',
  Initial: '#1976d2',
}
const NORMAL_COLOR = '#388e3c'
// Maintenance / Suppressed are intentional non-issues and don't badge.
const BADGE_SEVERITIES = new Set(['Critical', 'Major', 'Minor', 'Initial'])

const iconCache = new Map()

function getIcon(color, severity, badgeColor, badgeSeverity, ncmNonCompliant, gateway) {
  const key = `${color}|${severity}|${badgeColor || ''}|${badgeSeverity || ''}|${ncmNonCompliant ? 'ncm' : ''}|${gateway ? 'gw' : ''}`
  if (!iconCache.has(key)) {
    const titles = [
      gateway && 'Gateway — shown for its SD-WAN tunnels',
      ncmNonCompliant && 'Configuration non-compliant (NCM)',
    ].filter(Boolean)
    const classes = ['device-marker-dot', ncmNonCompliant && 'ncm-noncompliant', gateway && 'gateway']
      .filter(Boolean)
      .join(' ')
    const badge = badgeColor
      ? `<div class="device-marker-badge" style="background:${badgeColor}" ` +
        `data-severity="${badgeSeverity}"></div>`
      : ''
    iconCache.set(
      key,
      L.divIcon({
        className: 'device-marker',
        html:
          `<div class="${classes}" ` +
          `style="background:${color}" data-severity="${severity}"` +
          `${titles.length ? ` title="${titles.join(' · ')}"` : ''}>${badge}</div>`,
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
    const deviceTop = topDeviceSeverity(device.alarms)
    const color = SEVERITY_COLOR[deviceTop] || NORMAL_COLOR
    const componentTop = topComponentSeverity(device.alarms)
    const showBadge = BADGE_SEVERITIES.has(componentTop)
    return getIcon(
      color,
      deviceTop || 'Normal',
      showBadge ? SEVERITY_COLOR[componentTop] : null,
      showBadge ? componentTop : null,
      // A red ring marks an NCM non-compliant configuration, independent of
      // the alarm colour: a device can be alarm-free and still non-compliant.
      device.ncm?.status === 'noncompliant',
      // A square marks a gateway: drawn for its tunnels, not as one of the group's devices.
      device.gateway === true,
    )
  }, [device.alarms, device.ncm?.status, device.gateway])

  return (
    <Marker position={[device.latitude, device.longitude]} icon={icon}>
      <TabbedPopup device={device} apiKey={weatherApiKey} />
    </Marker>
  )
}
