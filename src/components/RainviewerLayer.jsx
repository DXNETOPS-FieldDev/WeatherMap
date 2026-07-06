import { useEffect, useState } from 'react'
import { LayerGroup, TileLayer } from 'react-leaflet'

const TILE_SIZE = 256
const COLOR_SCHEME = 2 // "Universal Blue" — matches WeatherMap's existing radar look
const SMOOTH = 1
const SNOW_COLORS = 1
const FRAME_INTERVAL_MS = 500
const OPACITY = 0.6 // matches Precipitation/Temperature/Wind/Clouds in this same menu

function tileUrl(host, frame) {
  return `${host}${frame.path}/${TILE_SIZE}/{z}/{x}/{y}/${COLOR_SCHEME}/${SMOOTH}_${SNOW_COLORS}.png`
}

/**
 * Animated RainViewer radar tiles. Auto-advances through `frames` on a
 * loop for as long as this component is mounted — no play/pause control,
 * matching every other overlay in the Env menu (checking the box is the
 * only interaction).
 *
 * Renders one permanent <TileLayer> per frame, keyed by timestamp, and
 * animates by toggling `opacity` on whichever one is current each tick
 * — every other frame sits at opacity 0. This is what actually makes
 * playback smooth: Leaflet's setUrl() (what a single reused TileLayer
 * would need every tick) tears down and rebuilds every visible tile's
 * DOM element even when the image is browser-cached, which reads as
 * choppy at a 500ms cadence. A stable layer per frame only ever pays
 * that DOM cost once, the first time each frame is shown; the layer
 * stays mounted afterward and repeat visits are a plain opacity flip.
 *
 * All frames mount immediately, so there's a brief burst of tile
 * requests when the overlay is checked (RainViewer's `past` array is
 * a small, bounded ~13 frames — a 2-hour window at 10-min steps).
 *
 * All layers are wrapped in one <LayerGroup> — a LayersControl.Overlay
 * registers a checkbox for any layer-creating element rendered inside
 * it, not just a single direct child, so bare sibling <TileLayer>s
 * would each register their own "Weather Radar" checkbox. LayerGroup
 * bundles them into the single control entry this overlay should be.
 *
 * `frames`/`host` come from fetchRadarFrames() in App.jsx, refreshed on
 * config.rainviewer.refreshIntervalMs (RainViewer's frames update every
 * ~10 min).
 */
export default function RainviewerLayer({ host, frames }) {
  const [frameIndex, setFrameIndex] = useState(0)

  useEffect(() => {
    if (frames.length === 0) return
    const timer = setInterval(() => {
      setFrameIndex((i) => (i + 1) % frames.length)
    }, FRAME_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [frames.length])

  if (frames.length === 0) return null

  const currentTime = frames[frameIndex % frames.length].time

  return (
    <LayerGroup>
      {frames.map((frame, i) => (
        <TileLayer
          key={frame.time}
          url={tileUrl(host, frame)}
          opacity={frame.time === currentTime ? OPACITY : 0}
          attribution={
            i === 0
              ? 'Weather data by <a href="https://rainviewer.com" target="_blank">RainViewer</a>'
              : undefined
          }
        />
      ))}
    </LayerGroup>
  )
}
