/**
 * Pure logic for NCM (Network Configuration Manager) configuration
 * compliance: matching map devices to NCM devices, normalizing NCM's
 * compliance values, and pulling failed-policy detail out of audit events.
 *
 * No fetch, no config, no DOM — so it can be unit-tested under plain Node
 * (`npm test`). The network side lives in src/api/ncm.js.
 *
 * Design rule: a device's compliance *status* always comes from NCM's
 * device record (`devicePolicyCompliance`), which is NCM's current answer.
 * Audit events only supply detail — failed policies and audit time — and
 * only when they agree with that status. The audit log keeps history the
 * device has since moved past (a device can be NotAudited today while its
 * newest event is an old NonCompliant one), so status derived from events
 * would be wrong.
 */

const KNOWN_STATUSES = new Set(['compliant', 'noncompliant', 'notaudited', 'error', 'didnotqualify'])

// Two NCM devices claiming the same name or IP. Matching on that value gives
// no answer — a wrong compliance badge is worse than none.
const AMBIGUOUS = Symbol('ambiguous')

const ACTION_COMPLIANT = 'device compliant'
const ACTION_NONCOMPLIANT = 'device noncompliant'

// NCM writes policy lists as `<resourceKey>#<policy name>`. Only strip a
// prefix that looks like a key, so a name such as "Rule #5" survives intact.
const POLICY_KEY_PREFIX = /^[0-9a-f]{16,}#/i

function normalizeHost(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().replace(/\.+$/, '')
}

function isIpAddress(value) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':')
}

function shortHost(host) {
  if (!host || isIpAddress(host)) return ''
  return host.split('.')[0]
}

function addToIndex(map, key, device) {
  if (!key) return
  const existing = map.get(key)
  if (existing === undefined) map.set(key, device)
  else if (existing !== device) map.set(key, AMBIGUOUS)
}

function lookup(map, key) {
  if (!key) return null
  const hit = map.get(key)
  return hit === undefined || hit === AMBIGUOUS ? null : hit
}

function normalizeAction(actionType) {
  return typeof actionType === 'string' ? actionType.trim().toLowerCase() : ''
}

function deviceKeyOf(ncmDevice) {
  return ncmDevice?.resourceIdentityInfo?.resourceKey || null
}

function toDate(epochMs) {
  return Number.isFinite(epochMs) ? new Date(epochMs) : null
}

/**
 * Index NCM device records for matching. Each device is reachable by its
 * full host name (NCM's `hostName` and `deviceName`), by short name, and by
 * management IP. A value shared by two devices is marked ambiguous.
 */
export function buildNcmIndex(ncmDevices) {
  const index = { byHost: new Map(), byShort: new Map(), byIp: new Map() }
  for (const device of Array.isArray(ncmDevices) ? ncmDevices : []) {
    if (!device || typeof device !== 'object') continue
    for (const name of [device.hostName, device.deviceName]) {
      const host = normalizeHost(name)
      addToIndex(index.byHost, host, device)
      addToIndex(index.byShort, shortHost(host), device)
    }
    addToIndex(index.byIp, normalizeHost(device.mgmtIpAddress), device)
  }
  return index
}

/**
 * The NCM device for a map device, or null. Tries the full host name, then
 * the short name, then the IP. A tier with an ambiguous value is skipped
 * rather than guessed at. Name beats IP, because a multi-interface router is
 * often managed by NCM on a different address than PC reports as primary.
 */
export function matchNcmDevice(index, { name, ip } = {}) {
  if (!index) return null
  const host = normalizeHost(name)
  return (
    lookup(index.byHost, host) ||
    lookup(index.byShort, shortHost(host)) ||
    lookup(index.byIp, normalizeHost(ip)) ||
    null
  )
}

/**
 * NCM's `devicePolicyCompliance` as one of: compliant, noncompliant,
 * notaudited, error, didnotqualify — or 'unrecognized' for anything else, so
 * an unexpected value can never read as compliant.
 */
export function normalizeComplianceStatus(value) {
  if (typeof value !== 'string') return 'unrecognized'
  const key = value.toLowerCase().replace(/[\s_-]/g, '')
  return KNOWN_STATUSES.has(key) ? key : 'unrecognized'
}

/** Policy names from the `label` line of an NCM audit event payload. */
export function parsePolicyList(payload, label) {
  if (typeof payload !== 'string') return []
  const line = payload
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith(label))
  if (!line) return []
  const names = line
    .slice(label.length)
    .split(',')
    .map((entry) => entry.trim().replace(POLICY_KEY_PREFIX, '').trim())
    .filter(Boolean)
  return [...new Set(names)]
}

/**
 * The newest compliance event (Device Compliant or Device NonCompliant) for
 * each NCM device, keyed by device resourceKey. Events without a device key
 * are skipped; most NCM events carry no IP, so the key is the only safe join.
 */
export function latestComplianceEventByDevice(events) {
  const latest = new Map()
  for (const e of Array.isArray(events) ? events : []) {
    const action = normalizeAction(e?.actionType)
    if (action !== ACTION_COMPLIANT && action !== ACTION_NONCOMPLIANT) continue
    const key = e?.deviceId?.resourceKey
    if (!key) continue
    const prev = latest.get(key)
    if (!prev || (e.eventTime || 0) > (prev.eventTime || 0)) latest.set(key, e)
  }
  return latest
}

/**
 * What the popup shows for one device: `{ status, auditTime, failedPolicies }`.
 * Status comes from the device record; the event contributes detail only
 * when it belongs to this device and agrees with that status.
 */
export function complianceDetails(ncmDevice, latestEvent) {
  if (!ncmDevice) return { status: 'notinncm', auditTime: null, failedPolicies: [] }

  const status = normalizeComplianceStatus(ncmDevice.devicePolicyCompliance)
  const key = deviceKeyOf(ncmDevice)
  const ownEvent = latestEvent && key && latestEvent.deviceId?.resourceKey === key ? latestEvent : null
  const action = normalizeAction(ownEvent?.actionType)

  if (status === 'noncompliant' && action === ACTION_NONCOMPLIANT) {
    return {
      status,
      auditTime: toDate(ownEvent.eventTime),
      failedPolicies: parsePolicyList(ownEvent.payload, 'Failed Policies:'),
    }
  }
  if (status === 'compliant' && action === ACTION_COMPLIANT) {
    return { status, auditTime: toDate(ownEvent.eventTime), failedPolicies: [] }
  }
  return { status, auditTime: null, failedPolicies: [] }
}

/**
 * Link to the device's audit trails in the NCM web UI, or null when no
 * http(s) base URL is configured or the record lacks its keys.
 */
export function ncmDeviceLink(uiBaseUrl, ncmDevice) {
  if (typeof uiBaseUrl !== 'string') return null
  const trimmed = uiBaseUrl.trim()
  if (!/^https?:\/\/[^/]/i.test(trimmed)) return null
  const networkKey = ncmDevice?.network?.resourceKey
  const deviceKey = deviceKeyOf(ncmDevice)
  if (!networkKey || !deviceKey) return null
  return (
    `${trimmed.replace(/\/+$/, '')}/ncm-portal/networks/device-details/` +
    `${encodeURIComponent(networkKey)}/${encodeURIComponent(deviceKey)}/audit-trails`
  )
}

/**
 * Everything the map needs about one of its devices:
 * `{ status, auditTime, failedPolicies, link, ncmName }`.
 * `latestEvents` may be null (the events fetch failed or was skipped) — the
 * status is still correct, only the detail is missing.
 */
export function ncmInfoForDevice(index, latestEvents, device, uiBaseUrl) {
  const ncmDevice = matchNcmDevice(index, { name: device?.name, ip: device?.ip })
  const key = deviceKeyOf(ncmDevice)
  const event = key && latestEvents ? latestEvents.get(key) : undefined
  return {
    ...complianceDetails(ncmDevice, event),
    link: ncmDevice ? ncmDeviceLink(uiBaseUrl, ncmDevice) : null,
    ncmName: ncmDevice?.deviceName || null,
  }
}

/**
 * The map devices NCM reports as non-compliant — what the Network menu's
 * "Non-Compliant Devices" filter shows. Audit errors, unknown statuses and
 * devices NCM doesn't manage are not non-compliant, so they're excluded.
 */
export function nonCompliantDevices(devices) {
  return (Array.isArray(devices) ? devices : []).filter((d) => d?.ncm?.status === 'noncompliant')
}
