/**
 * Lines of a device marker's hover tooltip: host name, IP address, and a note when NCM reports the
 * configuration non-compliant. Missing values are left out rather than shown as empty lines.
 */
export function deviceTooltipLines(device) {
  const text = (v) => (typeof v === 'string' ? v.trim() : '')
  const name = text(device?.name)
  const ip = text(device?.ip)
  const lines = []
  if (name) lines.push(name)
  if (ip) lines.push(ip)
  if (lines.length === 0) lines.push('Unnamed device')
  if (device?.ncm?.status === 'noncompliant') lines.push('Configuration non-compliant (NCM)')
  return lines
}
