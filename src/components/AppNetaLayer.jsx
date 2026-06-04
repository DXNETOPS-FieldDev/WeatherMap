import { LayerGroup, Marker, Polyline, Popup } from 'react-leaflet'
import L from 'leaflet'
import { getConfig } from '../lib/config.js'

// Target-anchor marker — used for the non-MP endpoints of AppNeta paths
// (ISP labels like "chicago-isp-1", public hostnames like "web.mydomain.com",
// raw IPs that happen to carry geo via AppNeta's targetLocation). The
// globe-with-orbit icon visually distinguishes these from real devices
// (cluster bubbles) and MPs (bullseye). 28px matches the MP bullseye so
// the two AppNeta-layer marker types read as visual peers.
const TARGET_ICON = L.icon({
  iconUrl: './appneta-target-icon.png',
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -16],
})

// AppNeta MP marker — a classic bullseye target: concentric thin rings
// with a crosshair through the full diameter and a small centre dot.
// Inline SVG so colours/sizing are version-controlled; no PNG asset.
// 28px keeps the marker compact (per "don't make it too big") while
// still extending slightly past a co-located cluster bubble (~28px) so
// at least the outer ring + crosshair tips remain visible.
const MP_ICON = L.divIcon({
  html:
    '<svg width="26" height="26" xmlns="http://www.w3.org/2000/svg">' +
      // Crosshair lines span the full diameter
      '<line x1="0" y1="13" x2="26" y2="13" stroke="#000" stroke-width="1" />' +
      '<line x1="13" y1="0" x2="13" y2="26" stroke="#000" stroke-width="1" />' +
      // Concentric rings (4 of them) — stroke only, no fill, so anything
      // beneath (e.g. a co-located cluster bubble) shows through.
      '<circle cx="13" cy="13" r="12"  stroke="#000" stroke-width="1" fill="none" />' +
      '<circle cx="13" cy="13" r="9"   stroke="#000" stroke-width="1" fill="none" />' +
      '<circle cx="13" cy="13" r="6"   stroke="#000" stroke-width="1" fill="none" />' +
      '<circle cx="13" cy="13" r="3"   stroke="#000" stroke-width="1" fill="none" />' +
      // Centre bullseye dot
      '<circle cx="13" cy="13" r="1.2" fill="#000" />' +
    '</svg>',
  className: 'appneta-mp-target',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
  popupAnchor: [0, -13],
})

// Same 4-band palette as the SDWAN tunnel layer — visual consistency for
// users who flip between SD-WAN Tunnels and AppNeta MPs overlays.
const HEALTH_COLOR = {
  good: '#388e3c',
  minor: '#fbc02d',
  warn: '#f57c00',
  bad: '#d32f2f',
  unknown: '#9e9e9e',
}
const LEVEL_NAME = ['good', 'minor', 'warn', 'bad']

function levelFor(value, bands) {
  if (value == null) return -1
  if (value > bands[2]) return 3
  if (value > bands[1]) return 2
  if (value > bands[0]) return 1
  return 0
}

function healthFor(p, thresholds) {
  const max = Math.max(
    levelFor(p.latency, thresholds.latency),
    levelFor(p.dataLoss, thresholds.dataLoss),
    levelFor(p.dataJitter, thresholds.dataJitter),
  )
  return max < 0 ? 'unknown' : LEVEL_NAME[max]
}

function fmt(n, suffix = '') {
  if (n == null) return '—'
  return `${Math.round(n * 100) / 100}${suffix}`
}

function formatDate(s) {
  if (!s) return ''
  const d = new Date(s)
  return isNaN(d.getTime())
    ? s
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Hash → [-1, 1] used to bow each line in a different direction. AppNeta
// has many MP→same-target lines (e.g. 4 MPs all pointing at chicago-isp-1,
// or one MP with two paths to two ISP labels at the same coordinate), so
// without per-line offset they'd overlap.
//
// djb2 step + Knuth multiplicative avalanche. The plain `(h<<5)-h+c` from
// TunnelLayer doesn't disperse small input changes — two consecutive path
// IDs (e.g. Denver's 309617 / 309618 both going to NYC) produced hashes
// that differed by 0.001, collapsing both polylines onto the same curve.
// The avalanche step spreads sequential-ID changes across the output range.
function pairKey(p) {
  return `${p.sourceDeviceId}->${p.id}`
}
function hashStr(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) + s.charCodeAt(i)) | 0
  }
  h = Math.imul(h ^ (h >>> 16), 2654435761)
  return (((h >>> 0) % 2000) / 1000) - 1
}

function curvedPath(src, dst, controlMag, segments = 20) {
  const dLat = dst[0] - src[0]
  const dLon = dst[1] - src[1]
  const len = Math.sqrt(dLat * dLat + dLon * dLon)
  if (len < 0.001) return [src, dst]
  const perpLat = -dLon / len
  const perpLon = dLat / len
  const ctrlLat = (src[0] + dst[0]) / 2 + perpLat * controlMag
  const ctrlLon = (src[1] + dst[1]) / 2 + perpLon * controlMag
  const points = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const u = 1 - t
    points.push([
      u * u * src[0] + 2 * u * t * ctrlLat + t * t * dst[0],
      u * u * src[1] + 2 * u * t * ctrlLon + t * t * dst[1],
    ])
  }
  return points
}

/**
 * Render AppNeta Network Paths as curved Polylines from MP source to target
 * geo-anchor, plus a small teal CircleMarker at every MP source and a small
 * grey dot at each target anchor.
 *
 * MP markers always render — App.jsx filters AppNeta MPs out of the device
 * cluster when this layer is on, so each MP gets exactly one marker (the
 * teal dot here) regardless of which overlays are checked.
 *
 * The teal palette is deliberately distinct from the cluster's severity
 * colors (green/orange/red) so users can tell at a glance which markers
 * are AppNeta MPs vs regular devices.
 *
 * Props:
 *   paths       normalized path records from src/api/appneta.js
 *   appnetaMps  MP devices from fetchAppNetaMpDevices()
 */
export default function AppNetaLayer({ paths, appnetaMps }) {
  // Never early-return — keep the LayerGroup mounted even when paths/MPs
  // filter to empty. Returning null caused react-leaflet's Overlay to lose
  // track of the layer, so re-checking an MP in the legend (which would
  // re-populate visibleAppnetaPaths) didn't bring the layer back.
  const safePaths = paths || []
  const safeMps = appnetaMps || []

  const cfg = getConfig().appnetaPaths
  const thresholds = cfg.thresholds
  const curveMagnitude = cfg.curveMagnitude ?? 0.9

  // Index paths by an anchor key so multiple paths sharing the same target
  // coords get their endpoint marker rendered once with a combined popup.
  const anchors = new Map()
  for (const p of safePaths) {
    const key = `${p.targetLat.toFixed(4)},${p.targetLng.toFixed(4)}`
    let a = anchors.get(key)
    if (!a) {
      a = { lat: p.targetLat, lng: p.targetLng, locality: p.targetLocality, paths: [] }
      anchors.set(key, a)
    }
    a.paths.push(p)
  }

  return (
    <LayerGroup>
      {safeMps.map((m) => (
        <Marker
          key={`mp-${m.id}`}
          position={[m.latitude, m.longitude]}
          icon={MP_ICON}
          // Stack above the device cluster regardless of click order — a
          // user clicking the SDWan bubble underneath shouldn't be able
          // to bury the MP target. 1000 is well above Leaflet's default
          // lat-based zIndex range.
          zIndexOffset={1000}
        >
          <Popup>
            <div className="appneta-popup">
              <strong>
                {m.globalId != null ? (
                  <a
                    href={`/pc/redirector?ItemID=${m.globalId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {m.name}
                  </a>
                ) : (
                  m.name
                )}
              </strong>
              <br />
              <small>AppNeta Monitoring Point</small>
              {m.ip && <><br /><small>{m.ip}</small></>}
            </div>
          </Popup>
        </Marker>
      ))}

      {[...anchors.values()].map((a, i) => (
        <Marker
          key={`anchor-${i}`}
          position={[a.lat, a.lng]}
          icon={TARGET_ICON}
          // Stack above the device cluster, same as MP bullseyes — globe
          // targets often land on cities that also have SDWan devices
          // (NYC, Chicago) and would otherwise be buried.
          zIndexOffset={1000}
        >
          <Popup>
            <div className="appneta-popup">
              <strong>{a.locality || 'Target'}</strong>
              <br />
              <small>{a.paths.length} path{a.paths.length === 1 ? '' : 's'} terminate here</small>
              <hr />
              <div className="appneta-anchor-targets">
                {[...new Set(a.paths.map((p) => p.target))].sort().map((t) => (
                  <div key={t}>{t}</div>
                ))}
              </div>
            </div>
          </Popup>
        </Marker>
      ))}

      {safePaths.map((p) => {
        const color = HEALTH_COLOR[healthFor(p, thresholds)]
        const positions = curvedPath(
          [p.sourceLat, p.sourceLng],
          [p.targetLat, p.targetLng],
          curveMagnitude * hashStr(pairKey(p)),
        )
        const h = healthFor(p, thresholds)
        const tintCls = h === 'minor' || h === 'warn' || h === 'bad'
          ? ` tunnel-row-${h}`
          : ''
        return (
          <Polyline
            key={`path-${p.id}`}
            positions={positions}
            pathOptions={{ color, weight: 2, opacity: 0.8 }}
          >
            <Popup>
              <div className="tunnel-popup">
                <strong>
                  {p.localId != null ? (
                    <a
                      href={`/pc/redirector?SourceType=262144&LocalID=${p.localId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {p.sourceName} → {p.target}
                    </a>
                  ) : (
                    <>{p.sourceName} → {p.target}</>
                  )}
                </strong>
                <br />
                <small>{p.protocol}{p.ispName ? ` · ${p.ispName}` : ''}{p.dualEnded ? ' · dual-ended' : ''}</small>
                {p.pcDescription && (
                  <>
                    <br />
                    <small className="path-popup-route">{p.pcDescription.replace(' <-> ', ' ↔ ')}</small>
                  </>
                )}
                <hr />
                <div className={`tunnel-row${tintCls}`}>
                  <div className="tunnel-metrics">
                    Latency: {fmt(p.latency, ' ms')} · Loss: {fmt(p.dataLoss, '%')} · Jitter: {fmt(p.dataJitter, ' ms')}
                  </div>
                  <div className="tunnel-metrics">
                    RTT: {fmt(p.rtt, ' ms')} · MOS: {fmt(p.mos)} · Voice loss: {fmt(p.voiceLoss, '%')} · Voice jitter: {fmt(p.voiceJitter, ' ms')}
                  </div>
                </div>
                {p.pcCreatedAt && (
                  <div className="path-popup-created">Created {formatDate(p.pcCreatedAt)}</div>
                )}
              </div>
            </Popup>
          </Polyline>
        )
      })}
    </LayerGroup>
  )
}
