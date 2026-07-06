/**
 * Fetch available RainViewer radar frames.
 *
 * API contract (https://www.rainviewer.com/api/weather-maps-api.html,
 * verified against the live endpoint 2026-07-06):
 *   GET https://api.rainviewer.com/public/weather-maps.json
 *   -> { host, radar: { past: [{ time, path }], nowcast: [{ time, path }] } }
 *
 * No auth required, CORS-enabled — called directly from the browser.
 * `nowcast` (short-range forecast frames) is typically empty but included
 * for completeness since it's part of the documented response shape.
 */

const FRAMES_URL = 'https://api.rainviewer.com/public/weather-maps.json'

export async function fetchRadarFrames() {
  const response = await fetch(FRAMES_URL)
  if (!response.ok) {
    throw new Error(`RainViewer fetch failed: HTTP ${response.status}`)
  }
  const data = await response.json()
  const frames = [...(data.radar?.past || []), ...(data.radar?.nowcast || [])]
  return { host: data.host || 'https://tilecache.rainviewer.com', frames }
}
