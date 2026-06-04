/**
 * Look up PC metadata for AppNeta network paths via the Data Aggregator's
 * /rest/sdn/networkpath/filtered/ endpoint (proxied through da-proxy.jsp).
 *
 * Why this exists:
 *   PC OData has no inventory entity for AppNeta network paths — only a
 *   metrics face (sdnpathmfs) that doesn't carry the LocalID we need to
 *   build a /pc/redirector?SourceType=262144&LocalID=<id> link. The DA's
 *   WebServices layer has full path inventory: LocalID, Description (the
 *   "city, state <-> city, state" route), CreateTime, etc.
 *
 * Correlation:
 *   The DA response is a <NetworkPathList> whose entries don't echo the
 *   AppNeta PathId we filtered on. So we correlate by name: PC names
 *   paths as "<sourceName> <-> <target> (single|dual)", and we can
 *   construct the same key from our AppNeta path fields.
 *
 * Returns Map<appnetaPathId, { localId, description, createTime }>.
 * Paths whose name doesn't match any PC entry are simply absent from
 * the map; callers fall back to plain-text in that case. One round-trip
 * per refresh.
 */
export async function fetchNetworkPathDetails(paths, { debug } = {}) {
  if (debug || !paths || paths.length === 0) return new Map()

  const filters = paths
    .map((p) => `      <SDNAppNetaAttrs.PathId type="EQUAL">${Number(p.id)}</SDNAppNetaAttrs.PathId>`)
    .join('\n')

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<FilterSelect xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
        'xsi:noNamespaceSchemaLocation="filter.xsd">\n' +
    '  <Filter>\n' +
    '    <Or>\n' +
    filters + '\n' +
    '    </Or>\n' +
    '  </Filter>\n' +
    '  <Select use="exclude" isa="exclude">\n' +
    '    <Item use="include"/>\n' +
    '  </Select>\n' +
    '</FilterSelect>'

  const response = await fetch('./da-proxy.jsp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml',
      'Accept': 'application/xml',
    },
    body: xml,
  })
  if (!response.ok) {
    throw new Error(`DA networkpath mapping: HTTP ${response.status}`)
  }

  const text = await response.text()
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('DA networkpath mapping: invalid XML response')
  }

  // Build PC-name → { localId, description, createTime } lookup.
  const pcByName = new Map()
  for (const np of doc.getElementsByTagName('NetworkPath')) {
    const idEl = np.getElementsByTagName('ID')[0]
    const item = np.getElementsByTagName('Item')[0]
    if (!idEl || !item || !idEl.textContent) continue
    const nameEl = item.getElementsByTagName('Name')[0]
    const descEl = item.getElementsByTagName('Description')[0]
    const ctEl = item.getElementsByTagName('CreateTime')[0]
    if (!nameEl || !nameEl.textContent) continue
    pcByName.set(nameEl.textContent.trim(), {
      localId: Number(idEl.textContent.trim()),
      description: descEl?.textContent?.trim() || null,
      createTime: ctEl?.textContent?.trim() || null,
    })
  }

  // Correlate AppNeta paths to PC entries. Try two keys:
  //   1. AppNeta's own path name (pathName / name). If the AppNeta→PC
  //      integration ingests paths under this name, it'll match
  //      PC's <Name> directly — catches cases where AppNeta's target
  //      string differs slightly from PC's (e.g. "demo-portal.com"
  //      in AppNeta vs "demo-portal" in PC's path name).
  //   2. Constructed "<sourceName> <-> <target> (single|dual)" — the
  //      typical PC format, used when AppNeta's name doesn't match.
  const map = new Map()
  for (const p of paths) {
    let details = p.name ? pcByName.get(p.name) : null
    if (!details) {
      const key = `${p.sourceName} <-> ${p.target} (${p.dualEnded ? 'dual' : 'single'})`
      details = pcByName.get(key)
    }
    if (details) {
      map.set(Number(p.id), details)
    }
  }
  return map
}
