/**
 * Matching for the map's "Find device…" box: by name or IP, literal text, case
 * insensitive. A name that starts with the text outranks one that merely
 * contains it, which outranks an IP match; ties are alphabetical by name. Same
 * rules as BandwidthMap's search. Pure, so it is unit-tested under `npm test`.
 */

export const MAX_HITS = 10

export function matchDevices(devices, query, limit = MAX_HITS) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q || !Array.isArray(devices)) return []

  const hits = []
  for (const device of devices) {
    const name = String(device?.name ?? '').toLowerCase()
    const ip = String(device?.ip ?? '').toLowerCase()
    const at = name.indexOf(q)
    if (at === 0) hits.push({ device, rank: 0 })
    else if (at > 0) hits.push({ device, rank: 1 })
    else if (ip.includes(q)) hits.push({ device, rank: 2 })
  }
  return hits
    .sort((a, b) => a.rank - b.rank || String(a.device.name ?? '').localeCompare(String(b.device.name ?? '')))
    .slice(0, limit)
    .map((h) => h.device)
}

/** The key a drawn marker is registered under, so a search hit can find it. */
export function markerKey(device) {
  return `${device?.gateway ? 'gateway' : 'device'}:${device?.id}`
}
