import { alarmsByDevice } from '../lib/threshold-alarms.js'

// Active threshold alarms for the "Thresholds" variant, from Performance Center
// OData `activealarms`. Mapping and severity logic live in
// src/lib/threshold-alarms.js.

const IDS_PER_REQUEST = 40 // 89 ids in one URL made Performance Center answer 400
const ROW_CAP = 5000
const COLUMNS = 'ID,ItemID,Severity,AlarmType,ProfileName,StartTime,ClearTime,Description,MetricValuesMax'

/** A positive whole number from a number or numeric string; null otherwise (Number(null) would be 0). */
function toDeviceId(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function batchUrl(batch) {
  const list = batch.join(',')
  // An interface alarm's ItemID is the interface, so match its device as well.
  const filter = `AlarmType eq 'Threshold' and (ItemID in (${list}) or interface/DeviceItemID in (${list}))`
  return '/pc/odata4/api/activealarms' +
    `?$filter=${encodeURIComponent(filter)}` +
    `&$expand=${encodeURIComponent('interface($select=Name,DeviceItemID)')}` +
    `&$select=${COLUMNS}&$top=${ROW_CAP}&$format=application/json`
}

/**
 * Resolves to `{ byDevice, truncated, errors }`. `byDevice` maps each device id
 * of a batch that answered to its alarms (worst first; [] when it has none); a
 * device whose batch failed has no entry, and the failure is named in `errors`.
 * `truncated` means a batch hit the row cap, so some alarms may be missing.
 */
export async function fetchThresholdAlarms(deviceIds, { debug } = {}) {
  const result = { byDevice: new Map(), truncated: false, errors: [] }
  const ids = [...new Set((Array.isArray(deviceIds) ? deviceIds : []).map(toDeviceId).filter((id) => id !== null))]
  if (debug || ids.length === 0) return result

  const batches = []
  for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) batches.push(ids.slice(i, i + IDS_PER_REQUEST))

  await Promise.all(batches.map(async (batch) => {
    try {
      const response = await fetch(batchUrl(batch), { headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      const rows = Array.isArray(body?.value) ? body.value : []
      if (rows.length >= ROW_CAP) result.truncated = true
      const grouped = alarmsByDevice(rows, batch)
      for (const id of batch) result.byDevice.set(id, grouped.get(id) ?? [])
    } catch (e) {
      result.errors.push(`Threshold alarms for ${batch.length} devices: ${e.message}`)
    }
  }))
  return result
}
