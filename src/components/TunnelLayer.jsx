import { LayerGroup, Polyline, Popup } from 'react-leaflet'
import { getConfig } from '../lib/config.js'

// SDWAN-style 4-band palette: green / yellow / orange / red, plus gray for
// no-data. Thresholds come from runtime-config.tunnels.thresholds so the
// customer can tune without a rebuild.
const HEALTH_COLOR = {
  good: '#388e3c',
  minor: '#fbc02d',
  warn: '#f57c00',
  bad: '#d32f2f',
  unknown: '#9e9e9e',
}

const LEVEL_NAME = ['good', 'minor', 'warn', 'bad']

// Returns 0/1/2/3 for the band (green/yellow/orange/red), or -1 for no data.
// `bands` is [greenMax, yellowMax, orangeMax] — values above orangeMax are red.
function levelFor(value, bands) {
  if (value == null) return -1
  if (value > bands[2]) return 3
  if (value > bands[1]) return 2
  if (value > bands[0]) return 1
  return 0
}

function healthFor(t, thresholds) {
  const max = Math.max(
    levelFor(t.packetLoss, thresholds.packetLoss),
    levelFor(t.latency, thresholds.latency),
    levelFor(t.jitter, thresholds.jitter),
  )
  return max < 0 ? 'unknown' : LEVEL_NAME[max]
}

function worstHealth(tunnels, thresholds) {
  let worstLevel = -1
  for (const t of tunnels) {
    const max = Math.max(
      levelFor(t.packetLoss, thresholds.packetLoss),
      levelFor(t.latency, thresholds.latency),
      levelFor(t.jitter, thresholds.jitter),
    )
    if (max > worstLevel) worstLevel = max
  }
  return worstLevel < 0 ? 'unknown' : LEVEL_NAME[worstLevel]
}

function fmt(n, suffix = '') {
  if (n == null) return '—'
  return `${Math.round(n * 100) / 100}${suffix}`
}

// Directed pair so Seattle→SF and SF→Seattle render as separate polylines,
// each bowed in a different direction via hash. Matches the SDWAN dashboard
// behavior of one line per directional tunnel set.
function pairKey(t) {
  return `${t.sourceId}-${t.destId}`
}

// Cheap deterministic hash of pair-key → [-1, 1]. Used to bow each polyline
// in a different direction so lines whose endpoints cluster geographically
// (e.g. Controller-01 + SF) become individually visible and clickable.
function hashStr(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return ((h % 2000) / 1000) - 1
}

// Quadratic-Bezier arc from src to dst. The control point sits perpendicular
// to the midpoint, offset by `controlMag` (in lat/lon degrees, signed).
// Lines whose hashes give opposite signs fan out in opposite directions so
// otherwise-overlapping polylines stay individually visible / clickable.
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

export default function TunnelLayer({ tunnels, devicesById }) {
  if (!tunnels || tunnels.length === 0) return null

  const cfg = getConfig().tunnels
  const thresholds = cfg.thresholds
  const curveMagnitude = cfg.curveMagnitude ?? 0.9
  const groups = new Map()
  for (const t of tunnels) {
    const key = pairKey(t)
    let g = groups.get(key)
    if (!g) {
      g = []
      groups.set(key, g)
    }
    g.push(t)
  }

  return (
    <LayerGroup>
      {[...groups.entries()].map(([key, groupTunnels]) => {
        const sample = groupTunnels[0]
        const src = devicesById.get(sample.sourceId)
        const dst = devicesById.get(sample.destId)
        if (!src || !dst) return null
        const color = HEALTH_COLOR[worstHealth(groupTunnels, thresholds)]
        const sorted = [...groupTunnels].sort((a, b) =>
          (a.name || '').localeCompare(b.name || ''),
        )
        return (
          <Polyline
            key={key}
            positions={curvedPath(
              [src.latitude, src.longitude],
              [dst.latitude, dst.longitude],
              curveMagnitude * hashStr(key),
            )}
            pathOptions={{ color, weight: 2, opacity: 0.8 }}
          >
            <Popup>
              <div className="tunnel-popup">
                <strong>{src.name} → {dst.name}</strong>
                <br />
                <small>{sorted.length} tunnel{sorted.length === 1 ? '' : 's'}</small>
                <hr />
                <div className="tunnel-list">
                  {sorted.map((t) => {
                    const h = healthFor(t, thresholds)
                    const tintCls = h === 'minor' || h === 'warn' || h === 'bad'
                      ? ` tunnel-row-${h}`
                      : ''
                    return (
                      <div key={t.id} className={`tunnel-row${tintCls}`}>
                        <div className="tunnel-name">{t.name}</div>
                        <div className="tunnel-metrics">
                          Jitter: {fmt(t.jitter, ' ms')} · Latency: {fmt(t.latency, ' ms')} · Loss: {fmt(t.packetLoss, '%')}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </Popup>
          </Polyline>
        )
      })}
    </LayerGroup>
  )
}
