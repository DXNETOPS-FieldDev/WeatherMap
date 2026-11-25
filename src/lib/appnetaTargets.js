// Drill-down links for an AppNeta target popup (the globe where paths end).
//
// AppNeta path targets are hidden from the device markers (isAppNetaDevice in src/api/odata.js), which also took
// away their link to PC's "Monitored Target" page. The target popup gives it back, and lists each path ending at
// the target with a link to its PC path page, where the path's latency, loss and jitter are.
import { isAppNetaDevice } from '../api/odata.js'

/**
 * Map<name, device> of the AppNeta records (targets and monitoring points) in the devices-query result.
 * A name held by two records is left out: we can't tell which one is current, so neither gets a link.
 */
export function targetRecordsByName(devices) {
  const byName = new Map()
  const dupes = new Set()
  for (const d of devices) {
    if (!d?.name || !isAppNetaDevice(d)) continue
    if (byName.has(d.name)) dupes.add(d.name)
    else byName.set(d.name, d)
  }
  for (const n of dupes) byName.delete(n)
  return byName
}

/**
 * One row per target among `paths` (sorted by name):
 *   { target, href, paths: [{ id, label, href }] }
 * `href` is the target's PC page when it has a PC record, else null; each path's `href` is its PC path page
 * when the DA gave it a LocalID, else null.
 */
export function targetPopupRows(paths, recordsByName) {
  const byTarget = new Map()
  for (const p of paths) {
    if (!byTarget.has(p.target)) byTarget.set(p.target, [])
    byTarget.get(p.target).push(p)
  }
  return [...byTarget.keys()].sort().map((target) => {
    const record = recordsByName.get(target)
    return {
      target,
      href: record?.globalId != null ? `/pc/redirector?ItemID=${record.globalId}` : null,
      paths: byTarget.get(target)
        .slice()
        .sort((a, b) => String(a.sourceName).localeCompare(String(b.sourceName)))
        .map((p) => ({
          id: p.id,
          label: `${p.sourceName} → ${p.target}`,
          href: p.localId != null ? `/pc/redirector?SourceType=262144&LocalID=${p.localId}` : null,
        })),
    }
  })
}

// Within this many degrees (about 5 km) two AppNeta markers are drawn on the same spot.
const SAME_SPOT_DEG = 0.05

const sameSpot = (lat1, lng1, lat2, lng2) =>
  Math.abs(lat1 - lat2) <= SAME_SPOT_DEG && Math.abs(lng1 - lng2) <= SAME_SPOT_DEG

/**
 * True when a target globe (`{ lat, lng }`) sits on a monitoring point. A city's ISP targets often carry the
 * MP's own coordinates, and the globe then covers the bullseye completely, so the layer draws it to one side.
 */
export function anchorSharesMpSpot(anchor, mps) {
  return mps.some(
    (m) => m.latitude != null && m.longitude != null && sameSpot(m.latitude, m.longitude, anchor.lat, anchor.lng),
  )
}

/**
 * Groups items that sit on the same spot, so each spot gets one marker: `[{ lat, lng, items }]`, in input order,
 * each group at its first item's point. Two markers there would be drawn one on top of the other, and the one
 * underneath could not be clicked. Items without coordinates are left out.
 */
export function groupBySpot(items, latOf, lngOf) {
  const groups = []
  for (const item of items) {
    const lat = latOf(item)
    const lng = lngOf(item)
    if (lat == null || lng == null) continue
    const g = groups.find((x) => sameSpot(x.lat, x.lng, lat, lng))
    if (g) g.items.push(item)
    else groups.push({ lat, lng, items: [item] })
  }
  return groups
}
