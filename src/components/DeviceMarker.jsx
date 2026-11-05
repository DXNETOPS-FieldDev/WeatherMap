import { useMemo } from 'react'
import { Marker } from 'react-leaflet'
import L from 'leaflet'
import { topDeviceSeverity, topComponentSeverity } from '../api/spectrum.js'
import TabbedPopup from './TabbedPopup.jsx'
import { worstSelectedSeverity } from '../lib/threshold-alarms.js'

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

function getIcon(color, severity, badgeColor, badgeSeverity, ncmNonCompliant) {
  const key = `${color}|${severity}|${badgeColor || ''}|${badgeSeverity || ''}|${ncmNonCompliant ? 'ncm' : ''}`
  if (!iconCache.has(key)) {
    const badge = badgeColor
      ? `<div class="device-marker-badge" style="background:${badgeColor}" ` +
        `data-severity="${badgeSeverity}"></div>`
      : ''
    iconCache.set(
      key,
      L.divIcon({
        className: 'device-marker',
        html:
          `<div class="device-marker-dot${ncmNonCompliant ? ' ncm-noncompliant' : ''}" ` +
          `style="background:${color}" data-severity="${severity}"` +
          `${ncmNonCompliant ? ' title="Configuration non-compliant (NCM)"' : ''}>${badge}</div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
        popupAnchor: [0, -9],
      }),
    )
  }
  return iconCache.get(key)
}

// Thresholds variant: alarms not loaded (or their query failed).
const UNKNOWN_COLOR = '#9e9e9e'

export default function DeviceMarker({ device, weatherApiKey, selectedSeverities }) {
  const icon = useMemo(() => {
    const ncmNonCompliant = device.ncm?.status === 'noncompliant'
    // Thresholds variant (selectedSeverities given): one color for the device
    // and its interfaces together, from the worst ticked severity; no badge.
    if (selectedSeverities) {
      if (device.thresholdAlarms == null) return getIcon(UNKNOWN_COLOR, 'Unknown', null, null, ncmNonCompliant)
      const worst = worstSelectedSeverity(device.thresholdAlarms, selectedSeverities)
      return getIcon(SEVERITY_COLOR[worst] || NORMAL_COLOR, worst || 'Normal', null, null, ncmNonCompliant)
    }
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
      ncmNonCompliant,
    )
  }, [device.alarms, device.ncm?.status, device.thresholdAlarms, selectedSeverities])

  // The same array between renders: react-leaflet calls setLatLng whenever the
  // position prop is a new object, and markercluster answers a "move" by removing
  // and re-adding the marker, which folds a spidered-out cluster back up and
  // closes its open popup. Every 60-second refresh re-renders the markers.
  const position = useMemo(() => [device.latitude, device.longitude], [device.latitude, device.longitude])

  return (
    <Marker position={position} icon={icon}>
      <TabbedPopup device={device} apiKey={weatherApiKey} selectedSeverities={selectedSeverities} />
    </Marker>
  )
}
