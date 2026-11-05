import { aggregateDeviceBandwidth, normalizePortSample, pickAvailability } from '../lib/bandwidth.js'

// The popup's Metrics tab for the "network" profile: per-device Availability
// and Bandwidth In/Out. Pure arithmetic lives in src/lib/bandwidth.js.

const BANDWIDTH_WINDOW_SECONDS = 900 // the newest 15 minutes before the end of the range
const AVAILABILITY_MAX_SECONDS = 86_400 // a longer range would pull thousands of rows per device
const DEFAULT_RANGE_SECONDS = 3600
const IDS_PER_REQUEST = 40 // 89 ids in one URL made Performance Center answer 400
const ROW_CAP = 20_000

const PORT_COLUMNS = [
  'ID', 'DeviceItemID', 'Timestamp', 'im_BitsPerSecondIn', 'im_BitsPerSecondOut',
  'im_SpeedIn', 'im_SpeedOut', 'im_HistoricalInterfaceSpeed',
].join(',')

/** Epoch seconds from epoch seconds, epoch milliseconds or an ISO string; null if unusable. */
function toEpochSeconds(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (Number.isFinite(n)) return Math.floor(n > 1e11 ? n / 1000 : n)
  const parsed = Date.parse(v)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
}

/** A positive whole number from a number or numeric string; null otherwise (Number(null) would be 0). */
function toDeviceId(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

async function getRows(url, label) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`${label} query failed: HTTP ${response.status}`)
  const body = await response.json()
  return Array.isArray(body?.value) ? body.value : []
}

function meanByDevice(rows, field) {
  const sums = new Map()
  for (const r of rows) {
    const v = Number(r[field])
    if (r[field] === null || r[field] === undefined || r[field] === '' || !Number.isFinite(v)) continue
    const s = sums.get(r.DeviceItemID) || { total: 0, n: 0 }
    s.total += v
    s.n += 1
    sums.set(r.DeviceItemID, s)
  }
  return new Map([...sums].map(([id, s]) => [id, s.total / s.n]))
}

/**
 * Availability and bandwidth for the devices on the map.
 *
 * Resolves to `{ byDevice, truncated, errors }`. `byDevice` maps a device id to
 * `{ bandwidth, availability }`: `bandwidth` is aggregateDeviceBandwidth's entry
 * or null; `availability` is `{ value, kind }` (see pickAvailability). A failing
 * query is named in `errors` and leaves only its own figure empty; `truncated`
 * means a query hit the row cap, so the newest samples may be missing.
 */
export async function fetchNetworkMetrics({ groupId, deviceIds, startTime, endTime, debug } = {}) {
  const result = { byDevice: new Map(), truncated: false, errors: [] }
  const ids = [...new Set((Array.isArray(deviceIds) ? deviceIds : []).map(toDeviceId).filter((id) => id !== null))]
  if (debug || ids.length === 0) return result

  const end = toEpochSeconds(endTime) ?? Math.floor(Date.now() / 1000)
  const rangeStart = toEpochSeconds(startTime) ?? end - DEFAULT_RANGE_SECONDS
  const availabilityStart = Math.max(rangeStart, end - AVAILABILITY_MAX_SECONDS)

  const guard = async (label, task) => {
    try {
      return await task()
    } catch (e) {
      result.errors.push(`${label}: ${e.message}`)
      return []
    }
  }
  const capped = (rows) => {
    if (rows.length >= ROW_CAP) result.truncated = true
    return rows
  }
  const familyUrl = (family, field, batch) =>
    `/pc/odata4/api/${family}` +
    `?$filter=DeviceItemID in (${batch.join(',')})` +
    `&starttime=${availabilityStart}&endtime=${end}` +
    `&$select=DeviceItemID,${field}&$top=${ROW_CAP}&$format=application/json`

  const bandwidthRows = groupId == null
    ? Promise.resolve([])
    : guard('bandwidth', async () =>
        capped(await getRows(
          `/pc/odata4/api/portmfs?$filter=groups/any(L1:L1/ID eq ${groupId})` +
            `&starttime=${end - BANDWIDTH_WINDOW_SECONDS}&endtime=${end}` +
            `&$select=${PORT_COLUMNS}&$expand=${encodeURIComponent('interface($select=Name)')}` +
            `&$top=${ROW_CAP}&$format=application/json`,
          'Bandwidth',
        )))
  const family = (name, field, label) =>
    Promise.all(chunk(ids, IDS_PER_REQUEST).map((batch) =>
      guard(label, async () => capped(await getRows(familyUrl(name, field, batch), label))),
    )).then((parts) => parts.flat())

  const [bwRows, availRows, reachRows] = await Promise.all([
    bandwidthRows,
    family('availabilitymfs', 'im_Availability', 'availability'),
    family('reachabilitymfs', 'im_Reachability', 'reachability'),
  ])

  const bandwidth = aggregateDeviceBandwidth(bwRows.map(normalizePortSample).filter(Boolean))
  const availability = meanByDevice(availRows, 'im_Availability')
  const reachability = meanByDevice(reachRows, 'im_Reachability')
  for (const id of ids) {
    result.byDevice.set(id, {
      bandwidth: bandwidth.get(id) ?? null,
      availability: pickAvailability({ availability: availability.get(id), reachability: reachability.get(id) }),
    })
  }
  return result
}
