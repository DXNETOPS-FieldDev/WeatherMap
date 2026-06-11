/**
 * Fetch active alarms for a list of devices from Spectrum via a same-origin
 * proxy. Returns both device-level AND interface-level alarms — each one
 * routed back to its parent device by alarmed-model handle.
 *
 * Why three round-trips (was one):
 *   Spectrum keeps device-level and port-level alarms on different model
 *   handles. A simple name-equals filter on 0x1006e only catches the device
 *   ones. To surface port alarms (e.g. "Se3/3 LINK DISABLED"), we walk the
 *   topology: device name → handle → child interface handles, then filter
 *   alarms by 0x129fa (alarmed model handle) ORed across all of them. The
 *   relation we use, 0x10004, returns only Gen_IF_Port / Serial_IF_Port —
 *   no SNMP framework noise.
 *
 * Two proxy backends are supported, selected by the `?proxy=` URL param:
 *   - 'jsp' (default): hits ./spectrum-proxy.jsp shipped in this App View.
 *   - 'nginx':         hits /spectrum/restful/... — requires a customer
 *                      nginx location block to forward the request.
 * Either way, the proxy injects Basic auth server-side; the browser never
 * sees Spectrum credentials.
 */

function spectrumUrl(path, qs) {
  const mode = new URLSearchParams(window.location.search).get('proxy') || 'jsp'
  if (mode === 'nginx') {
    return qs ? `/spectrum/${path}?${qs}` : `/spectrum/${path}`
  }
  return qs
    ? `./spectrum-proxy.jsp?path=${encodeURIComponent(path)}&${qs}`
    : `./spectrum-proxy.jsp?path=${encodeURIComponent(path)}`
}

const ATTRS = [
  '0x11f56', // Severity (int 0-6)
  '0x11f4e', // Creation time (epoch seconds)
  '0x1006e', // Model name (device name OR <device>_<ifName> for ports)
  '0x10000', // Model type (Rtr_Cisco / ViptelaDev / Gen_IF_Port / Serial_IF_Port / ...)
  '0x129fa', // Alarmed model handle — the key we route by
  '0x12b4c', // Alarm Title (human-readable text; OneClick uses this)
]

const SEVERITY = [
  'Normal', 'Minor', 'Major', 'Critical', 'Maintenance', 'Suppressed', 'Initial',
]

export async function fetchSpectrumAlarmsForDevice(modelName) {
  return fetchSpectrumAlarmsForDevices([modelName])
}

/**
 * Returns a Map keyed by device model name → array of alarms.
 * Devices with no alarms are present in the map with an empty array.
 * Each alarm has { id, severity, title, occurredAt, component } where
 * `component` is set (e.g. "Se3/3") when the alarm is on an interface
 * model, and null for device-level alarms.
 */
export async function fetchSpectrumAlarmsForDevices(modelNames) {
  const grouped = new Map(modelNames.map((n) => [n, []]))
  if (modelNames.length === 0) return grouped

  // 1. Resolve device names → model handles. Devices not in Spectrum just
  //    won't appear in the map and will get an empty alarm list below.
  const nameToMh = await resolveDeviceHandles(modelNames)
  if (nameToMh.size === 0) return grouped

  // 2. Enumerate physical-interface child handles for each device, in
  //    parallel. Non-fatal per device — one device's enumeration failing
  //    doesn't block the others' alarms.
  const mhToDeviceName = new Map()
  for (const [name, mh] of nameToMh) mhToDeviceName.set(mh, name)
  const interfaceMhs = new Set()
  await Promise.all(
    [...nameToMh].map(async ([name, mh]) => {
      try {
        const children = await enumerateInterfaceHandles(mh)
        for (const ch of children) {
          mhToDeviceName.set(ch, name)
          interfaceMhs.add(ch)
        }
      } catch (e) {
        console.warn(`Spectrum interface enumeration failed for ${name}:`, e.message)
      }
    }),
  )

  // 3. Single alarm query OR'ing 0x129fa (alarmed model handle) across
  //    every device and interface handle we know about.
  const orClauses = [...mhToDeviceName.keys()]
    .map((h) => `<equals><attribute id="0x129fa"><value>${h}</value></attribute></equals>`)
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
    const parsed = parseAlarm(alarm, mhToDeviceName, interfaceMhs)
    if (parsed.deviceName && grouped.has(parsed.deviceName)) {
      grouped.get(parsed.deviceName).push(parsed)
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

// Split top-severity so the marker can show the device's own state on the
// main dot and the component state as a small corner badge — matches the
// topology / OneClick convention the customer asked for.
export function topDeviceSeverity(alarms) {
  return topSeverity((alarms || []).filter((a) => !a.component))
}
export function topComponentSeverity(alarms) {
  return topSeverity((alarms || []).filter((a) => a.component))
}

async function resolveDeviceHandles(names) {
  const orClauses = names
    .map((n) => `<equals><attribute id="0x1006e"><value>${escapeXml(n)}</value></attribute></equals>`)
    .join('')
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rs:model-request throttlesize="500"' +
    ' xmlns:rs="http://www.ca.com/spectrum/restful/schema/request"' +
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
    ' xsi:schemaLocation="http://www.ca.com/spectrum/restful/schema/request ../../../xsd/Request.xsd">' +
    '<rs:target-models>' +
    '<rs:models-search>' +
    '<rs:search-criteria xmlns="http://www.ca.com/spectrum/restful/schema/filter">' +
    `<filtered-models><or>${orClauses}</or></filtered-models>` +
    '</rs:search-criteria>' +
    '</rs:models-search>' +
    '</rs:target-models>' +
    '<rs:requested-attribute id="0x1006e"/>' +
    '</rs:model-request>'

  const response = await fetch(spectrumUrl('restful/models'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml', Accept: 'application/json' },
    body,
  })
  if (!response.ok) {
    throw new Error(`Spectrum device handle lookup failed: HTTP ${response.status}`)
  }
  const data = await response.json()
  const raw = data?.['model-response-list']?.['model-responses']?.model
  const out = new Map()
  if (!raw) return out
  const list = Array.isArray(raw) ? raw : [raw]
  for (const m of list) {
    const mh = m['@mh']
    const attrs = flattenAttrs(m)
    const name = attrs['0x1006e']
    if (mh && name) out.set(name, mh)
  }
  return out
}

// Relation 0x10004 returns the device's physical interface children
// (Gen_IF_Port / Serial_IF_Port). No SNMP framework noise — clean.
async function enumerateInterfaceHandles(deviceMh) {
  const response = await fetch(
    spectrumUrl(`restful/associations/relation/0x10004/model/${deviceMh}`, 'side=left'),
    { method: 'GET', headers: { Accept: 'application/json' } },
  )
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const data = await response.json()
  const raw = data?.['association-response-list']?.['association-responses']?.association
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map((a) => a['@rightmh']).filter(Boolean)
}

function flattenAttrs(node) {
  const raw = node.attribute || []
  return (Array.isArray(raw) ? raw : [raw]).reduce((acc, a) => {
    if (a && a['@id']) acc[a['@id']] = a.$
    return acc
  }, {})
}

function parseAlarm(alarm, mhToDeviceName, interfaceMhs) {
  const attrs = flattenAttrs(alarm)
  const mh = attrs['0x129fa']
  const deviceName = mh ? mhToDeviceName.get(mh) || null : null
  const isInterface = mh ? interfaceMhs.has(mh) : false
  const modelName = attrs['0x1006e'] || null
  // Interface models are named "<deviceName>_<ifName>" on this Spectrum.
  // Strip the prefix so the popup shows just "Se3/3" instead of the
  // full "C3.mydomain.com_Se3/3".
  let component = null
  if (isInterface && modelName) {
    component =
      deviceName && modelName.startsWith(`${deviceName}_`)
        ? modelName.slice(deviceName.length + 1)
        : modelName
  }
  const sevInt = Number(attrs['0x11f56'])
  const epochSec = Number(attrs['0x11f4e'])

  return {
    id: alarm['@id'],
    deviceName,
    component,
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
