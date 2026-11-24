import Papa from 'papaparse'
import { getConfig } from '../lib/config.js'
import { gatewayFilter } from '../lib/gateways.js'

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
  return fillComponentMetrics(devices, { startTime, endTime }, { resolution: getConfig().odata.resolution })
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

export function componentMetricsQuery(set, ids, { startTime, endTime }, resolution) {
  return (
    `/pc/odata4/api/${set}` +
    `?$filter=${encodeURIComponent(`DeviceItemID in (${ids.join(',')})`)}` +
    `&$apply=${encodeURIComponent('groupby((DeviceItemID),aggregate(im_Utilization with average as Value))')}` +
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

function buildDevicesQuery({ id, startTime, endTime }) {
  return devicesUrl(`(Latitude ne null) and (groups/any(L1:L1/ID eq ${id}))`, { startTime, endTime })
}

/**
 * Fetch the configured gateways (devices outside the dashboard's group that
 * its devices tunnel to; see src/lib/gateways.js) by ID / exact name, with the
 * same columns, metrics and time window as the group's devices.
 *
 * Unlike the group query, nothing is filtered out: a gateway without
 * coordinates comes back so it can be reported rather than silently missing,
 * and the controller / AppNeta exclusions don't apply to a device that was
 * listed on purpose. Names match exactly, including case (PC compares them
 * case-sensitively). Resolves to [] with no request when nothing is configured.
 */
export async function fetchGatewayDevices({ refs, startTime, endTime, debug }) {
  const filter = gatewayFilter(refs)
  if (debug || !filter) return []

  const response = await fetch(devicesUrl(encodeURIComponent(filter), { startTime, endTime }))
  if (!response.ok) {
    throw new Error(`Gateways query failed: HTTP ${response.status}`)
  }
  // A device with several metric items can come back on several rows.
  const byId = new Map()
  for (const d of parseDevicesCsv(await response.text(), { explicit: true })) {
    if (!byId.has(d.id)) byId.set(d.id, d)
  }
  return [...byId.values()]
}

// `filter` goes into the URL as given: the group filter has always been sent
// unencoded, and must stay byte-for-byte the same.
function devicesUrl(filter, { startTime, endTime }) {
  // Relative path — resolves against whatever host the App View is loaded
  // from (dev-netops, prod-netops, etc.) so no env-specific edit is needed.
  const { topLimit, resolution } = getConfig().odata
  return (
    '/pc/odata4/api/devices' +
    '?$select=GlobalID,ID,Name,PrimaryIPAddress,Location,Longitude,Latitude' +
    `&$filter=${filter}` +
    '&$expand=cpuandmemorymfs($apply=groupby((DeviceItemID),' +
      'aggregate(' +
        'im_CPUUtilization with average as Value,' +
        'im_MemoryUtilization with average as Value1,' +
        'im_DiskPercentUsed with average as Value2' +
      ')))' +
    `&starttime=${startTime}` +
    `&endtime=${endTime}` +
    `&resolution=${resolution}` +
    '&$format=text/csv' +
    `&$top=${topLimit}`
  )
}

// `explicit`: the devices were asked for by name/ID, so keep every row.
function parseDevicesCsv(text, { explicit = false } = {}) {
  const { data } = Papa.parse(text, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  })

  if (explicit) return data.map(normalizeDevice)

  const { includeAppNeta, includeSdwanControllers } = getConfig()
  return data
    .map(normalizeDevice)
    .filter((d) => isRenderable(d))
    .filter((d) => includeAppNeta || !isAppNetaDevice(d))
    .filter((d) => includeSdwanControllers || !isSdwanController(d))
}

// AppNeta Monitoring Points (e.g. "dev-vk35-Miami-AppNeta") are synthetic
// probes, not real network devices — excluded by default via the
// `includeAppNeta` runtime-config flag.
function isAppNetaDevice(device) {
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

function normalizeDevice(row) {
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
    disk: numOrNull(row['cpuandmemorymfs/Value2']),
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
