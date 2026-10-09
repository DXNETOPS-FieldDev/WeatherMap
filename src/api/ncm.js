import { getConfig } from '../lib/config.js'
import {
  buildNcmIndex,
  latestComplianceEventByDevice,
  normalizeComplianceStatus,
} from '../lib/ncm-compliance.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** runtime-config.json's optional `ncm` block, with defaults filled in. */
export function ncmConfig() {
  const c = getConfig().ncm || {}
  return {
    uiBaseUrl: c.uiBaseUrl || null,
    refreshIntervalMs: c.refreshIntervalMs || 15 * 60 * 1000,
    lookbackDays: c.lookbackDays || 365,
  }
}

/**
 * Load NCM compliance through ncm-proxy.jsp.
 *
 * Resolves to one of:
 *   { enabled: false }                       — NCM isn't configured on this
 *                                              Portal (the proxy answers 404).
 *                                              The UI shows nothing at all.
 *   { enabled: true, index, latestEvents }   — ready. `latestEvents` is null
 *                                              if only the detail fetch failed.
 *   { enabled: true, error }                 — configured but failing; the UI
 *                                              says so rather than hiding it.
 *
 * Status comes from the device list. Audit events are fetched only when at
 * least one device has a status they can add detail to.
 */
export async function fetchNcmCompliance() {
  let res
  try {
    res = await fetch('./ncm-proxy.jsp?op=devices', { headers: { Accept: 'application/json' } })
  } catch (e) {
    return { enabled: true, error: `NCM proxy unreachable: ${e.message}` }
  }
  if (res.status === 404) return { enabled: false }
  if (!res.ok) return { enabled: true, error: await errorText(res) }

  let devices
  try {
    devices = await res.json()
  } catch {
    return { enabled: true, error: 'NCM returned a device list that is not JSON' }
  }
  if (!Array.isArray(devices)) {
    return { enabled: true, error: 'NCM returned an unexpected device list shape' }
  }

  const index = buildNcmIndex(devices)
  const needsDetail = devices.some((d) => {
    const s = normalizeComplianceStatus(d?.devicePolicyCompliance)
    return s === 'noncompliant' || s === 'compliant'
  })
  if (!needsDetail) return { enabled: true, index, latestEvents: null }

  const since = Date.now() - ncmConfig().lookbackDays * DAY_MS
  try {
    const ev = await fetch(`./ncm-proxy.jsp?op=events&since=${since}`, {
      headers: { Accept: 'application/json' },
    })
    if (!ev.ok) throw new Error(await errorText(ev))
    const body = await ev.json()
    return { enabled: true, index, latestEvents: latestComplianceEventByDevice(body.auditRecords) }
  } catch (e) {
    // Status is still right without events; only failed-policy detail is lost.
    console.warn('NCM audit-event fetch failed:', e.message)
    return { enabled: true, index, latestEvents: null }
  }
}

async function errorText(res) {
  const text = (await res.text().catch(() => '')).trim()
  // A load balancer may substitute an HTML error page; don't show markup.
  const clean = text.startsWith('<') ? '' : text.slice(0, 200)
  return `NCM proxy HTTP ${res.status}${clean ? `: ${clean}` : ''}`
}
