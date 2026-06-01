/**
 * Fetch active alarms for a device from Spectrum via a same-origin proxy.
 *
 * Two proxy backends are supported, selected by the `?proxy=` URL param:
 *   - 'jsp' (default): hits ./spectrum-proxy.jsp shipped in this App View.
 *                      Works as long as PC's Tomcat processes JSPs under
 *                      /pc/apps/user/<app>/. No env config needed.
 *   - 'nginx':         hits /spectrum/restful/... — requires a customer
 *                      nginx location block to forward the request.
 *
 * Either way, the proxy injects Basic auth server-side; the browser never
 * sees Spectrum credentials.
 */

function spectrumUrl(path) {
  const mode = new URLSearchParams(window.location.search).get('proxy') || 'jsp'
  return mode === 'nginx'
    ? `/spectrum/${path}`
    : `./spectrum-proxy.jsp?path=${encodeURIComponent(path)}`
}

const ATTRS = [
  '0x11f56', // Severity (int 0-6)
  '0x11f4e', // Creation time (epoch seconds)
  '0x1006e', // Model name
  '0x12b4c', // Alarm Title (human-readable text; OneClick uses this)
]

const SEVERITY = [
  'Normal', 'Minor', 'Major', 'Critical', 'Maintenance', 'Suppressed', 'Initial',
]

export async function fetchSpectrumAlarmsForDevice(modelName) {
  return fetchSpectrumAlarmsForDevices([modelName])
}

/**
 * Batched fetch — one POST returns alarms for all named devices.
 * Returns a Map keyed by model name (0x1006e) → array of alarms.
 * Devices with no alarms are present in the map with an empty array.
 */
export async function fetchSpectrumAlarmsForDevices(modelNames) {
  const grouped = new Map(modelNames.map((n) => [n, []]))
  if (modelNames.length === 0) return grouped

  const orClauses = modelNames
    .map((n) => `<equals><attribute id="0x1006e"><value>${escapeXml(n)}</value></attribute></equals>`)
    .join('')

  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rs:alarm-request throttlesize="500"' +
    ' xmlns:rs="http://www.ca.com/spectrum/restful/schema/request"' +
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
    ' xsi:schemaLocation="http://www.ca.com/spectrum/restful/schema/request ../../../xsd/Request.xsd">' +
    '<rs:attribute-filter>' +
    '<search-criteria xmlns="http://www.ca.com/spectrum/restful/schema/filter">' +
    `<filtered-models><and><or>${orClauses}</or></and></filtered-models>` +
    '</search-criteria>' +
    '</rs:attribute-filter>' +
    ATTRS.map((a) => `<rs:requested-attribute id="${a}"/>`).join('') +
    '</rs:alarm-request>'

  const response = await fetch(spectrumUrl('restful/alarms'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml', Accept: 'application/json' },
    body,
  })
  if (!response.ok) {
    throw new Error(`Spectrum alarms query failed: HTTP ${response.status}`)
  }
  const data = await response.json()
  const raw = data?.['alarm-response-list']?.['alarm-responses']?.alarm
  if (!raw) return grouped
  const list = Array.isArray(raw) ? raw : [raw]
  for (const alarm of list) {
    const parsed = parseAlarm(alarm)
    if (parsed.modelName && grouped.has(parsed.modelName)) {
      grouped.get(parsed.modelName).push(parsed)
    }
  }
  return grouped
}

// Higher rank = more severe. Anything not in the map (or null) → 0.
const SEVERITY_RANK = {
  Critical: 4, Major: 3, Minor: 2, Initial: 1, Maintenance: 0, Suppressed: 0, Normal: 0,
}

/**
 * Return the severity label of the most-severe alarm in the list, or null
 * if the list is empty or contains only sub-actionable severities.
 */
export function topSeverity(alarms) {
  let top = null
  let topRank = 0
  for (const a of alarms || []) {
    const r = SEVERITY_RANK[a.severity] ?? 0
    if (r > topRank) { topRank = r; top = a.severity }
  }
  return top
}

function parseAlarm(alarm) {
  const rawAttrs = alarm.attribute || []
  const attrs = (Array.isArray(rawAttrs) ? rawAttrs : [rawAttrs]).reduce((acc, a) => {
    acc[a['@id']] = a.$
    return acc
  }, {})

  const sevInt = Number(attrs['0x11f56'])
  const epochSec = Number(attrs['0x11f4e'])

  return {
    id: alarm['@id'],
    modelName: attrs['0x1006e'] || null,
    severity: Number.isFinite(sevInt) ? SEVERITY[sevInt] || String(sevInt) : null,
    title: attrs['0x12b4c'] || '(no title)',
    occurredAt: Number.isFinite(epochSec) ? new Date(epochSec * 1000) : null,
  }
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[c]))
}
