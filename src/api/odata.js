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
  return parseDevicesCsv(text)
}

function buildDevicesQuery({ id, startTime, endTime }) {
  // Relative path — resolves against whatever host the App View is loaded
  // from (dev-netops, prod-netops, etc.) so no env-specific edit is needed.
  const { topLimit, resolution } = getConfig().odata
  return (
    '/pc/odata4/api/devices' +
    '?$select=GlobalID,ID,Name,PrimaryIPAddress,Location,Longitude,Latitude' +
    `&$filter=(Latitude ne null) and (groups/any(L1:L1/ID eq ${id}))` +
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
