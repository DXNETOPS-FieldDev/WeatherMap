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
  const name = row.interface?.Name
  return {
    deviceId,
    interfaceId,
    interfaceName: typeof name === 'string' && name !== '' ? name : null,
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

const interfacePct = (traffic, speed) => (typeof traffic === 'number' && speed > 0 ? (100 * traffic) / speed : null)

/**
 * The interface with the highest utilization in either direction, as
 * `{ interfaceId, name, utilInPct, utilOutPct }`, or null when no interface
 * has a percentage (no speed, or no traffic measured). Ties: lower id.
 */
function busiestInterface(samples) {
  let best = null
  let bestPct = -Infinity
  for (const s of samples) {
    const utilInPct = interfacePct(s.inBps, s.speedInBps)
    const utilOutPct = interfacePct(s.outBps, s.speedOutBps)
    if (utilInPct === null && utilOutPct === null) continue
    const pct = Math.max(utilInPct ?? -Infinity, utilOutPct ?? -Infinity)
    if (pct > bestPct || (pct === bestPct && s.interfaceId < best.interfaceId)) {
      best = { interfaceId: s.interfaceId, name: s.interfaceName ?? null, utilInPct, utilOutPct }
      bestPct = pct
    }
  }
  return best
}

/**
 * Per-device totals from interface samples, as a Map of deviceId to
 * `{ interfaces, inBps, outBps, utilInPct, utilOutPct, busiest }` (busiest: see
 * busiestInterface — threshold rules fire per interface, so this is the figure
 * that explains a marker's color when the combined percentage is low).
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
      busiest: busiestInterface(list),
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


/**
 * The WAN circuits list: one entry per member of the configured interface group
 * (metrics.wanGroup), per device, as a Map of deviceId to circuits sorted worst
 * first (higher of In / Out), circuits without a sample last, ties by name. Each is
 * `{ interfaceId, name, alias, sampled, inBps, outBps, speedInBps, speedOutBps,
 * inPct, outPct }`. The newest sample counts; speeds come from it, else from the
 * inventory. A circuit with no sample keeps null figures — never an invented 0 %.
 * `interfaces` are PC `interfaces` rows; `samples` come from normalizePortSample.
 */
export function wanCircuitsByDevice(interfaces, samples) {
  const newest = new Map()
  for (const s of Array.isArray(samples) ? samples : []) {
    if (!s || typeof s !== 'object') continue
    const prev = newest.get(s.interfaceId)
    if (!prev || (s.t ?? -Infinity) >= (prev.t ?? -Infinity)) newest.set(s.interfaceId, s)
  }
  const pct = (bps, speed) => (typeof bps === 'number' && speed > 0 ? (100 * bps) / speed : null)
  const out = new Map()
  for (const row of Array.isArray(interfaces) ? interfaces : []) {
    const interfaceId = num(row?.ID)
    const deviceId = num(row?.DeviceItemID)
    if (interfaceId === null || deviceId === null) continue
    const s = newest.get(interfaceId)
    const invIn = toBps(num(row.SpeedIn) ?? 0)
    const invOut = toBps(num(row.SpeedOut) ?? 0) || invIn
    const speedInBps = s?.speedInBps > 0 ? s.speedInBps : invIn
    const speedOutBps = s?.speedOutBps > 0 ? s.speedOutBps : invOut
    const alias = typeof row.Alias === 'string' && row.Alias.trim() ? row.Alias : null
    const circuit = {
      interfaceId,
      name: row.Name ?? null,
      alias,
      sampled: Boolean(s),
      inBps: s ? s.inBps : null,
      outBps: s ? s.outBps : null,
      speedInBps,
      speedOutBps,
      inPct: s ? pct(s.inBps, speedInBps) : null,
      outPct: s ? pct(s.outBps, speedOutBps) : null,
    }
    if (!out.has(deviceId)) out.set(deviceId, [])
    out.get(deviceId).push(circuit)
  }
  const worst = (c) => Math.max(c.inPct ?? -1, c.outPct ?? -1)
  for (const list of out.values()) {
    list.sort((a, b) => (a.sampled === b.sampled ? 0 : a.sampled ? -1 : 1)
      || worst(b) - worst(a)
      || String(a.name ?? '').localeCompare(String(b.name ?? '')))
  }
  return out
}
