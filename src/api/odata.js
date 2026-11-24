import Papa from 'papaparse'
import { getConfig } from '../lib/config.js'

/**
 * Fetch device inventory + average CPU utilization for the dashboard's
 * group context and time range. Returns an array of normalized device objects.
 *
 * In debug mode, loads /sample-devices.csv from the public/ folder instead
 * of hitting the OData API. Useful for development without portal access.
 *
 * The OData 4.0 query was converted from the original 2.0 form via
 * convertToOdata4_patched.py. Behavior preserved:
 *  - Filters to devices in the current group that have geo-location set
 *  - Aggregates per-device average CPU utilization for the time window
 *  - Resolution and per-query device cap come from runtime-config.json
 *    (odata.resolution, odata.topLimit) so customers can tune without rebuild.
 */
export async function fetchDevices({ id, startTime, endTime, debug }) {
  const url = debug
    ? '/sample-devices.csv'
    : buildDevicesQuery({ id, startTime, endTime })

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Devices query failed: HTTP ${response.status}`)
  }
  const text = await response.text()
  const devices = parseDevicesCsv(text)
  if (debug) return devices
  const window = { startTime, endTime }
  const { resolution } = getConfig().odata
  const withCpu = await fillComponentMetrics(devices, window, { resolution })
  return fillAvailability(withCpu, window, { resolution })
}

// Some devices report CPU and memory only per component — one row per CPU in cpumfs, one per memory pool in
// memorymfs — and have nothing in the device-level cpuandmemorymfs the devices query reads (measured
// 2026-11-24: 22 of 109 lab devices, among them Cisco routers and switches). For those, fall back to the
// component values, averaged across the device's CPUs or pools: the same number PC's own "Average CPU /
// Memory Utilization" gauges show (checked on a 49-CPU, 4-pool device: 50.26% / 49.43% in both).
const COMPONENT_FAMILIES = [
  { set: 'cpumfs', field: 'cpu' },
  { set: 'memorymfs', field: 'memory' },
]

export function componentMetricsQuery(set, ids, { startTime, endTime }, resolution, field = 'im_Utilization') {
  return (
    `/pc/odata4/api/${set}` +
    `?$filter=${encodeURIComponent(`DeviceItemID in (${ids.join(',')})`)}` +
    `&$apply=${encodeURIComponent(`groupby((DeviceItemID),aggregate(${field} with average as Value))`)}` +
    `&starttime=${startTime}` +
    `&endtime=${endTime}` +
    `&resolution=${resolution}` +
    '&$format=application/json'
  )
}

/** Map<DeviceItemID, average utilization>. A null average (not collected) is left out, not read as 0. */
export function parseComponentMetrics(resp) {
  const out = new Map()
  for (const row of Array.isArray(resp?.value) ? resp.value : []) {
    if (typeof row?.Value === 'number' && Number.isFinite(row.Value)) out.set(row.DeviceItemID, row.Value)
  }
  return out
}

/**
 * Fill each device's missing cpu / memory from its component metrics. Device-level values are never replaced.
 * Only devices missing a value are queried, in batches. A failed query leaves the devices as they were.
 */
// 40 ids per request: the Thresholds variant saw Performance Center answer 400 to 89 ids in one URL.
export async function fillComponentMetrics(devices, window, { fetchImpl = fetch, resolution, log = console, batchSize = 40 } = {}) {
  const found = {}
  try {
    for (const { set, field } of COMPONENT_FAMILIES) {
      const ids = devices.filter((d) => d[field] == null && d.id != null).map((d) => d.id)
      found[field] = new Map()
      for (let i = 0; i < ids.length; i += batchSize) {
        const response = await fetchImpl(componentMetricsQuery(set, ids.slice(i, i + batchSize), window, resolution))
        if (!response.ok) throw new Error(`${set} query failed: HTTP ${response.status}`)
        for (const [id, v] of parseComponentMetrics(await response.json())) found[field].set(id, v)
      }
    }
  } catch (e) {
    log.warn(`Component CPU/memory fallback skipped: ${e.message}`)
    return devices
  }
  return devices.map((d) => {
    const cpu = d.cpu ?? found.cpu.get(d.id) ?? null
    const memory = d.memory ?? found.memory.get(d.id) ?? null
    return cpu === d.cpu && memory === d.memory ? d : { ...d, cpu, memory }
  })
}

/**
 * The Metrics tab's "is it up?" line: each device's `availability` becomes `{ value, kind }`, the average
 * of im_Availability over the window (kind "availability"), or, for devices with none, of im_Reachability
 * (kind "reachability"), or null when PC reports neither. A device that is down has no availability at
 * all — PC shows it NOT REACHABLE — and reachability 0 %, so the fallback is what reports "down".
 * A failing query is logged and only leaves its own figure out.
 */
export async function fillAvailability(devices, window, { fetchImpl = fetch, resolution, log = console, batchSize = 40 } = {}) {
  const ids = devices.map((d) => d.id).filter((id) => id != null)
  if (ids.length === 0) return devices
  const averages = async (set, field, wanted) => {
    const out = new Map()
    try {
      for (let i = 0; i < wanted.length; i += batchSize) {
        const response = await fetchImpl(componentMetricsQuery(set, wanted.slice(i, i + batchSize), window, resolution, field))
        if (!response.ok) throw new Error(`${set} query failed: HTTP ${response.status}`)
        for (const [id, v] of parseComponentMetrics(await response.json())) out.set(id, v)
      }
    } catch (e) {
      log.warn(`Availability: ${e.message}`)
    }
    return out
  }
  const availability = await averages('availabilitymfs', 'im_Availability', ids)
  const reachability = await averages('reachabilitymfs', 'im_Reachability', ids.filter((id) => !availability.has(id)))
  return devices.map((d) => {
    if (availability.has(d.id)) return { ...d, availability: { value: availability.get(d.id), kind: 'availability' } }
    if (reachability.has(d.id)) return { ...d, availability: { value: reachability.get(d.id), kind: 'reachability' } }
    return { ...d, availability: null }
  })
}

function buildDevicesQuery({ id, startTime, endTime }) {
  // Relative path — resolves against whatever host the App View is loaded
  // from (dev-netops, prod-netops, etc.) so no env-specific edit is needed.
  const { topLimit, resolution } = getConfig().odata
  return (
    '/pc/odata4/api/devices' +
    '?$select=GlobalID,ID,Name,PrimaryIPAddress,Location,Longitude,Latitude,SupportedProtocols,PolledItemCount' +
    `&$filter=(Latitude ne null) and (groups/any(L1:L1/ID eq ${id}))` +
    '&$expand=cpuandmemorymfs($apply=groupby((DeviceItemID),' +
      'aggregate(' +
        'im_CPUUtilization with average as Value,' +
        'im_MemoryUtilization with average as Value1' +
      ')))' +
    `&starttime=${startTime}` +
    `&endtime=${endTime}` +
    `&resolution=${resolution}` +
    '&$format=text/csv' +
    `&$top=${topLimit}`
  )
}

function parseDevicesCsv(text) {
  const { data } = Papa.parse(text, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  })

  const { includeAppNeta, includeSdwanControllers } = getConfig()
  return data
    .map(normalizeDevice)
    .filter((d) => isRenderable(d))
    .filter((d) => includeAppNeta || !isAppNetaDevice(d))
    .filter((d) => includeSdwanControllers || !isSdwanController(d))
}

// AppNeta Monitoring Points (e.g. "dev-vk35-Miami-AppNeta") are synthetic
// probes, not real network devices — excluded by default via the
// `includeAppNeta` runtime-config flag. So are AppNeta path targets (an ISP
// hop, a web site): PC lists them as devices too, with no IP address, no
// protocols and nothing polled, whatever they are named. The AppNeta MPs
// overlay draws them as targets when it is on.
export function isAppNetaDevice(device) {
  if (!device) return false
  if (!device.ip && device.protocols === '' && device.polledItems === 0) return true
  if (!device.name) return false
  const n = device.name.toLowerCase()
  return n.includes('vk35') || n.includes('appneta')
}

// SD-WAN controllers (Viptela: vManage / vSmart / vBond; Versa: Controller-01)
// are management-plane devices, not data-plane endpoints — hidden by default
// via the `includeSdwanControllers` runtime-config flag.
function isSdwanController(device) {
  if (!device.name) return false
  const n = device.name.toLowerCase()
  return (
    n.includes('vmanage') ||
    n.includes('vsmart') ||
    n.includes('vbond') ||
    n === 'controller-01'
  )
}

export function normalizeDevice(row) {
  return {
    id: row.ID,
    globalId: row.GlobalID,
    name: row.Name,
    ip: row.PrimaryIPAddress,
    location: row.Location ?? '',
    latitude: Number(row.Latitude),
    longitude: Number(row.Longitude),
    cpu: numOrNull(row['cpuandmemorymfs/Value']),
    memory: numOrNull(row['cpuandmemorymfs/Value1']),
    // '' when PC sent the column empty; undefined when the column wasn't asked for.
    protocols: 'SupportedProtocols' in row ? (row.SupportedProtocols == null ? '' : String(row.SupportedProtocols)) : undefined,
    polledItems: numOrNull(row.PolledItemCount),
  }
}

function numOrNull(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// A device is renderable on the map if it has valid coordinates. Metric
// data is no longer required — marker color comes from alarm severity,
// and devices with alarms but no recent metric sample should still appear.
function isRenderable(device) {
  return (
    Number.isFinite(device.latitude) &&
    Number.isFinite(device.longitude) &&
    device.latitude !== 0 &&
    device.longitude !== 0
  )
}
