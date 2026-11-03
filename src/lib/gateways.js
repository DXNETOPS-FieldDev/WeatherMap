/**
 * Pure logic for "gateways": devices OUTSIDE the dashboard's group that the
 * group's devices tunnel to (a client's SD-WAN hubs, for example). WeatherMap
 * draws a tunnel only when both ends are on the map, so a site-level group
 * showed none. A deployment lists its gateways in runtime-config.json
 * (`gateways.devices`, names or numeric PC device IDs); this module parses that
 * list, builds the OData filter that fetches them, decides which to draw, and
 * explains why a configured gateway is or isn't showing.
 *
 * No fetch, no config, no DOM — unit-tested under plain Node (`npm test`).
 * The network side lives in src/api/odata.js and src/api/tunnels.js.
 */

// Long `or` lists in a URL make Performance Center answer HTTP 400, so the
// configured list is capped. A handful of gateways is the real use.
export const MAX_GATEWAY_REFS = 50

const DIGITS_ONLY = /^\d+$/

function positiveInt(n) {
  return Number.isSafeInteger(n) && n > 0
}

/**
 * The configured list as `{ ids, names, truncated }`. Numbers and digits-only
 * strings are device IDs; any other non-blank string is a device name. Junk is
 * ignored and duplicates collapse (names ignoring case, first spelling wins).
 */
export function parseGatewayRefs(devices) {
  const out = { ids: [], names: [], truncated: false }
  if (!Array.isArray(devices)) return out
  const seenIds = new Set()
  const seenNames = new Set()

  for (const entry of devices) {
    let id = null
    let name = null
    if (typeof entry === 'number') {
      if (positiveInt(entry)) id = entry
    } else if (typeof entry === 'string') {
      const text = entry.trim()
      if (!text) continue
      if (DIGITS_ONLY.test(text)) {
        const n = Number(text)
        if (positiveInt(n)) id = n
      } else {
        name = text
      }
    }
    if (id === null && name === null) continue
    if (id !== null ? seenIds.has(id) : seenNames.has(name.toLowerCase())) continue

    if (out.ids.length + out.names.length >= MAX_GATEWAY_REFS) {
      out.truncated = true
      break
    }
    if (id !== null) {
      seenIds.add(id)
      out.ids.push(id)
    } else {
      seenNames.add(name.toLowerCase())
      out.names.push(name)
    }
  }
  return out
}

/**
 * The OData `$filter` that selects the configured devices, e.g.
 * `(ID eq 7114 or Name eq 'SIN-GW-01')`, or null when nothing usable is
 * configured. Quotes inside a name are doubled, so a name can never escape its
 * literal. The caller URL-encodes the result.
 */
export function gatewayFilter(refs) {
  const ids = (Array.isArray(refs?.ids) ? refs.ids : []).filter(positiveInt)
  const names = (Array.isArray(refs?.names) ? refs.names : []).filter(
    (n) => typeof n === 'string' && n.trim() !== '',
  )
  const parts = [
    ...ids.map((id) => `ID eq ${id}`),
    ...names.map((n) => `Name eq '${n.replace(/'/g, "''")}'`),
  ]
  return parts.length ? `(${parts.join(' or ')})` : null
}

// Same rule as the map's own devices (src/api/odata.js isRenderable): a device
// can be drawn only with real coordinates.
function hasCoordinates(device) {
  return (
    Number.isFinite(device?.latitude) &&
    Number.isFinite(device?.longitude) &&
    device.latitude !== 0 &&
    device.longitude !== 0
  )
}

function toSet(value) {
  if (value instanceof Set) return value
  return new Set(Array.isArray(value) ? value : [])
}

function destinationCounts(tunnels) {
  const counts = new Map()
  for (const t of Array.isArray(tunnels) ? tunnels : []) {
    if (t) counts.set(t.destId, (counts.get(t.destId) || 0) + 1)
  }
  return counts
}

/**
 * Which fetched gateway devices to draw, each as a copy flagged `gateway: true`.
 * Automatic mode draws a gateway only when a tunnel ENDS at it (the fetch only
 * returns tunnels starting at the group's devices). `showAll` draws every
 * configured gateway that can be placed. A gateway that is already a member of
 * the group is the group's own marker, and one without coordinates can't be
 * drawn, so neither is ever returned.
 */
export function gatewaysToShow({ gateways, tunnels, groupDeviceIds, showAll } = {}) {
  const group = toSet(groupDeviceIds)
  const linked = destinationCounts(tunnels)
  return (Array.isArray(gateways) ? gateways : [])
    .filter((g) => g && hasCoordinates(g) && !group.has(g.id) && (showAll || linked.has(g.id)))
    .map((g) => ({ ...g, gateway: true }))
}

/**
 * One entry per configured reference (ids first, then names), saying why it is
 * or isn't showing: `{ ref, status, deviceIds, tunnels }` where status is
 *   notfound       no device matches (names match ignoring case)
 *   nocoordinates  found, but no latitude/longitude to place it
 *   ingroup        already a member of this dashboard's group
 *   notunnels      drawable, but the group has no tunnel to it
 *   ok             drawable, with `tunnels` tunnels from the group
 */
export function gatewayStatuses(refs, fetched, tunnels, groupDeviceIds) {
  const ids = Array.isArray(refs?.ids) ? refs.ids : []
  const names = Array.isArray(refs?.names) ? refs.names : []
  const devices = Array.isArray(fetched) ? fetched.filter(Boolean) : []
  const group = toSet(groupDeviceIds)
  const counts = destinationCounts(tunnels)

  const describe = (ref, matches) => {
    const deviceIds = matches.map((d) => d.id)
    if (matches.length === 0) return { ref, status: 'notfound', deviceIds, tunnels: 0 }
    const placeable = matches.filter(hasCoordinates)
    if (placeable.length === 0) return { ref, status: 'nocoordinates', deviceIds, tunnels: 0 }
    if (placeable.some((d) => group.has(d.id))) return { ref, status: 'ingroup', deviceIds, tunnels: 0 }
    const n = placeable.reduce((sum, d) => sum + (counts.get(d.id) || 0), 0)
    return { ref, status: n > 0 ? 'ok' : 'notunnels', deviceIds, tunnels: n }
  }

  return [
    ...ids.map((id) => describe(id, devices.filter((d) => d.id === id))),
    ...names.map((name) =>
      describe(
        name,
        devices.filter((d) => typeof d.name === 'string' && d.name.toLowerCase() === name.toLowerCase()),
      ),
    ),
  ]
}
