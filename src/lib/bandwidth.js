/**
 * Pure logic for a device's bandwidth and availability figures, as the
 * popup's Metrics tab shows them. No fetch, no config, no DOM: unit-tested
 * under plain Node (`npm test`).
 *
 * A device's bandwidth is the SUM over all its interfaces: total throughput
 * in and out, plus an aggregate utilization. The utilization is
 * capacity-weighted (traffic / capacity over the interfaces), never a sum or
 * an average of per-interface percentages: ten interfaces at 50% would "sum" to
 * 500%, and a busy 1 Gbps port beside an idle 10 Gbps one is not "50% used".
 *
 * Rules carried over from BandwidthMap's interface code
 * (Test-AppView/bandwidthmap/src/api/odata.js, fetchInterfaceMetrics):
 *  - only the newest 5-minute sample of each interface counts (an average
 *    would hide congestion);
 *  - im_BitsPerSecondIn/Out are already bits per second;
 *  - interface speeds come in mixed units: a speed under 100,000 is megabits.
 */

function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const toBps = (speed) => (speed > 0 && speed < 100_000 ? speed * 1_000_000 : speed)

/**
 * One portmfs row as a sample:
 * `{ deviceId, interfaceId, t, inBps, outBps, speedInBps, speedOutBps }`, or
 * null when the row can't be tied to a device and an interface. Traffic that
 * is missing stays null (it is not 0); a missing speed is 0 (unrated).
 */
export function normalizePortSample(row) {
  if (!row || typeof row !== 'object') return null
  const deviceId = num(row.DeviceItemID)
  const interfaceId = num(row.ID)
  if (deviceId === null || interfaceId === null) return null
  const speedIn = num(row.im_SpeedIn) ?? num(row.im_HistoricalInterfaceSpeed) ?? 0
  const speedOut = num(row.im_SpeedOut) ?? speedIn
  return {
    deviceId,
    interfaceId,
    t: num(row.Timestamp),
    inBps: num(row.im_BitsPerSecondIn),
    outBps: num(row.im_BitsPerSecondOut),
    speedInBps: toBps(speedIn),
    speedOutBps: toBps(speedOut),
  }
}

function direction(samples, bpsKey, speedKey) {
  let bps = null
  let ratedBps = 0
  let capacity = 0
  for (const s of samples) {
    const traffic = s[bpsKey]
    if (typeof traffic !== 'number') continue // not measured: left out of both sides
    bps = (bps ?? 0) + traffic
    if (s[speedKey] > 0) {
      ratedBps += traffic
      capacity += s[speedKey]
    }
  }
  return { bps, utilPct: capacity > 0 ? (100 * ratedBps) / capacity : null }
}

/**
 * Per-device totals from interface samples, as a Map of deviceId to
 * `{ interfaces, inBps, outBps, utilInPct, utilOutPct }`.
 *  - Throughput is the sum over the interfaces that were measured.
 *  - Utilization = traffic / capacity over the interfaces that were measured
 *    AND have a speed, so an unrated interface can't push it above reality.
 *    Not clamped: traffic above the line rate reads above 100.
 *  - null (not 0) when nothing was measured or there is no capacity.
 */
export function aggregateDeviceBandwidth(samples) {
  const newest = new Map()
  for (const s of Array.isArray(samples) ? samples : []) {
    if (!s || typeof s !== 'object') continue
    const key = `${s.deviceId}:${s.interfaceId}`
    const prev = newest.get(key)
    if (!prev || (s.t ?? -Infinity) >= (prev.t ?? -Infinity)) newest.set(key, s)
  }

  const byDevice = new Map()
  for (const s of newest.values()) {
    if (!byDevice.has(s.deviceId)) byDevice.set(s.deviceId, [])
    byDevice.get(s.deviceId).push(s)
  }

  const out = new Map()
  for (const [deviceId, list] of byDevice) {
    const inn = direction(list, 'inBps', 'speedInBps')
    const outt = direction(list, 'outBps', 'speedOutBps')
    out.set(deviceId, {
      interfaces: list.length,
      inBps: inn.bps,
      outBps: outt.bps,
      utilInPct: inn.utilPct,
      utilOutPct: outt.utilPct,
    })
  }
  return out
}

/**
 * Which availability figure to show: `availabilitymfs` (share of time up) when
 * the device reports it, else `reachabilitymfs` (share of ICMP polls answered),
 * labelled as such; otherwise nothing. The two families cover different
 * devices (on one instance no firewall reported availability), so a missing
 * value is never turned into 100%.
 */
export function pickAvailability(figures) {
  const availability = num(figures?.availability)
  if (availability !== null) return { value: availability, kind: 'availability' }
  const reachability = num(figures?.reachability)
  if (reachability !== null) return { value: reachability, kind: 'reachability' }
  return { value: null, kind: null }
}
