/**
 * Pure logic for the "Thresholds" variant: a device's color comes only from its
 * active threshold alarms (raised by Performance Management threshold profiles),
 * and only from the severities ticked in the Network menu. No fetch, no config,
 * no DOM — unit-tested under plain Node (`npm test`).
 *
 * Rows are Performance Center OData `activealarms` as seen on dev-netops:
 * ID, ItemID, Severity, AlarmType, ProfileName, StartTime, ClearTime, and an
 * `interface` (Name, DeviceItemID) for interface alarms, whose own device link
 * is null — so an interface alarm is attached through interface.DeviceItemID.
 */

/** Worst first. */
export const SEVERITIES = ['Critical', 'Major', 'Minor']
const RANK = new Map(SEVERITIES.map((s, i) => [s, i]))
const DEFAULT_SELECTED = ['Critical', 'Major']

// Numeric Severity codes -> labels. Measured on dev-netops 2026-11-04: threshold
// rules named "> 30%", "> 10%" and "> 3%" carried codes 0, 1 and 2, and the alarm
// console showed those same alarms as Critical, Major and Minor. Any other code
// stays unknown and never colors a marker.
const SEVERITY_CODES = new Map([[0, 'Critical'], [1, 'Major'], [2, 'Minor']])

/** 'Critical' | 'Major' | 'Minor', or null when unknown. */
export function severityLabel(raw) {
  if (typeof raw === 'number') return SEVERITY_CODES.get(raw) ?? null
  if (typeof raw !== 'string') return null
  const t = raw.trim().toLowerCase()
  return SEVERITIES.find((s) => s.toLowerCase() === t) ?? null
}

/**
 * The severities ticked when the map opens, from runtime-config
 * `alarms.severities`. Not a list: Critical + Major. An explicit empty list is
 * respected (nothing ticked).
 */
export function parseSelectedSeverities(value) {
  if (!Array.isArray(value)) return [...DEFAULT_SELECTED]
  const picked = new Set(value.map((v) => (typeof v === 'string' ? severityLabel(v) : null)).filter(Boolean))
  return SEVERITIES.filter((s) => picked.has(s))
}

function positiveInt(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function finiteOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * One active threshold alarm as
 * `{ id, deviceId, interfaceName, interfaceGlobalId, severity, rawSeverity, profile, ruleName, value, startTime, description }`,
 * where `value` is the measured value (MetricValuesMax). DescriptionExtended is
 * not used: on dev-netops its "Exceed Threshold" and "Max Polled Value" read 0.0
 * on every alarm, whatever the rule and the measurement.
 * or null when the row isn't one (another alarm type, already cleared, or not
 * attachable to a device).
 */
export function normalizeThresholdAlarm(row) {
  if (!row || typeof row !== 'object') return null
  if (typeof row.AlarmType !== 'string' || row.AlarmType.trim().toLowerCase() !== 'threshold') return null
  if (row.ClearTime) return null // 0 or null = not cleared
  const deviceId = positiveInt(row.interface?.DeviceItemID) ?? positiveInt(row.ItemID)
  if (deviceId === null) return null
  return {
    id: row.ID,
    deviceId,
    interfaceName: row.interface?.Name ?? null,
    interfaceGlobalId: positiveInt(row.interface?.GlobalID),
    severity: severityLabel(row.Severity),
    rawSeverity: row.Severity,
    profile: row.ProfileName ?? null,
    ruleName: (typeof row.Description === 'string' && row.Description.match(/Rule Name: ([^)]+)\)/)?.[1]) || null,
    value: finiteOrNull(row.MetricValuesMax),
    startTime: Number.isFinite(Number(row.StartTime)) ? Number(row.StartTime) : null,
    description: row.Description ?? null,
  }
}

const rankOf = (a) => (a.severity === null ? SEVERITIES.length : RANK.get(a.severity))

/**
 * The map's devices' active threshold alarms, as a Map of deviceId to a list
 * sorted worst severity first (unknown last), then newest first.
 */
export function alarmsByDevice(rows, deviceIds) {
  const wanted = new Set(Array.isArray(deviceIds) ? deviceIds : [])
  const out = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    const a = normalizeThresholdAlarm(r)
    if (!a || !wanted.has(a.deviceId)) continue
    if (!out.has(a.deviceId)) out.set(a.deviceId, [])
    out.get(a.deviceId).push(a)
  }
  for (const list of out.values()) {
    list.sort((x, y) => rankOf(x) - rankOf(y) || (y.startTime ?? 0) - (x.startTime ?? 0))
  }
  return out
}

/** The marker color: the worst ticked severity among the alarms, or null (green). */
export function worstSelectedSeverity(alarms, selected) {
  if (!Array.isArray(alarms) || !Array.isArray(selected)) return null
  const ticked = new Set(selected)
  let worst = null
  for (const a of alarms) {
    if (!a?.severity || !ticked.has(a.severity)) continue
    if (worst === null || RANK.get(a.severity) < RANK.get(worst)) worst = a.severity
  }
  return worst
}

/**
 * The Alarms tab: `{ shown, hidden }`. `shown` keeps the ticked severities (and
 * unknown ones, which no checkbox can hide), in input order; `hidden` counts
 * what was left out, by severity, so "hidden" is never mistaken for "none".
 */
export function partitionBySeverity(alarms, selected) {
  const ticked = new Set(Array.isArray(selected) ? selected : [])
  const shown = []
  const hidden = {}
  for (const a of Array.isArray(alarms) ? alarms : []) {
    if (!a) continue
    if (a.severity === null || ticked.has(a.severity)) shown.push(a)
    else hidden[a.severity] = (hidden[a.severity] || 0) + 1
  }
  return { shown, hidden }
}


/**
 * Where an alarm row links: its interface's Portal page for an interface alarm,
 * the device's for a device-level one, through the redirector (it picks the page
 * type). GlobalIDs only, never the OData ID (a different id space). null when
 * there is no safe id, so an interface alarm never links to its device instead.
 */
export function alarmItemUrl(alarm, deviceGlobalId) {
  if (!alarm || typeof alarm !== 'object') return null
  const id = alarm.interfaceName != null ? positiveInt(alarm.interfaceGlobalId) : positiveInt(deviceGlobalId)
  return id === null ? null : `/pc/redirector?ItemID=${id}`
}
