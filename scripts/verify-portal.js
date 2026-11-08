// verify-portal.js — re-run every check that has been verified on WeatherMap, against the
// dashboard that is open in a signed-in Playwright browser. Run it after EVERY build, before a
// zip is handed over: a fix that removes a side effect can break something that was already
// verified (a popup fix once left every cluster bubble grey), and only re-running all the checks
// catches that.
//
// How to run (Playwright MCP, signed in to the Portal):
//   1. Open the dashboard that holds the App View, on the group to test.
//   2. browser_run_code_unsafe with filename = <absolute path to this file>.
// It reads nothing from the repo and holds no host, page id or group id: everything comes from
// the open page. Written for the stable app and the Thresholds variant (detected from
// runtime-config); VERIFIED ON THE THRESHOLDS VARIANT ONLY (2026-11-05) — the stable path has not
// been run yet, so treat its first result as a check of the script too.
// Takes about two minutes (it waits for one data refresh).
//
// Proven able to fail (2026-11-05, Thresholds on dev): with refreshClusters() removed it failed the
// four cluster-colour checks; with the marker position memo removed it failed "popup survives a
// refresh"; the good build passed 17 of 17. (2026-11-08) With metrics.wanGroup set: a build listing only
// the first WAN circuit failed "WAN circuits listed = the group's members"; the good build passed 19 of 19.
//
// Every check prints how many items it looked at; a check that inspected nothing FAILS.
// It changes nothing on the server. It ticks and unticks the Network-menu severities and puts
// them back.

async (page) => {
  const results = []
  const record = (check, pass, inspected, detail) => results.push({ check, pass: Boolean(pass) && inspected > 0, inspected, detail })

  const COLOR = {
    'rgb(211, 47, 47)': 'Critical', 'rgb(245, 124, 0)': 'Major', 'rgb(251, 192, 45)': 'Minor',
    'rgb(25, 118, 210)': 'Initial', 'rgb(158, 158, 158)': 'Unknown', 'rgb(56, 142, 60)': 'Normal',
  }
  const RANK = { Critical: 5, Major: 4, Minor: 3, Initial: 2, Unknown: 1, Normal: 0 }
  const SEV_CODE = { 0: 'Critical', 1: 'Major', 2: 'Minor' }
  const worst = (sevs) => sevs.reduce((w, s) => ((RANK[s] ?? 0) > (RANK[w] ?? -1) ? s : w), 'Normal')
  const sleep = (ms) => page.waitForTimeout(ms)

  // ---- 0. Reload, capture the app's own alarm responses, find the frame ------------------
  const alarmBodies = []
  const alarmIds = new Set()
  const onResponse = async (resp) => {
    const u = resp.url()
    if (!u.includes('/pc/odata4/api/activealarms')) return
    try {
      const f = decodeURIComponent(u.split('$filter=')[1].split('&')[0])
      const m = f.match(/ItemID in \(([^)]*)\)/)
      if (m) m[1].split(',').forEach((id) => alarmIds.add(Number(id)))
      alarmBodies.push({ t: Date.now(), rows: (await resp.json()).value })
    } catch (e) { alarmBodies.push({ t: Date.now(), error: e.message }) }
  }
  page.on('response', onResponse)
  await page.reload()
  await sleep(10000)
  const frame = page.frames().find((f) => /\/pc\/apps\/user\/[^/]+\/index\.html/.test(f.url()))
  if (!frame) { page.off('response', onResponse); return { verdict: 'FAIL', reason: 'no App View frame on this page', url: page.url() } }
  const app = frame.url().match(/\/pc\/apps\/user\/([^/]+)\//)[1]
  const bundle = await frame.evaluate(() => [...document.scripts].map((s) => s.src.split('/').pop()).join(','))
  const config = await frame.evaluate(async () => (await fetch('./runtime-config.json', { cache: 'no-store' })).json())
  const thresholdMode = config.alarms?.thresholdOnly === true
  // Let the first alarm load finish (batches arrive together).
  for (let i = 0; i < 20 && thresholdMode; i++) {
    const last = alarmBodies.at(-1)?.t ?? 0
    if (alarmBodies.length && Date.now() - last > 3000) break
    await sleep(1000)
  }
  const banner = (await frame.locator('.status-banner').allInnerTexts()).join(' | ')
  record('banner shows devices', /\d+ devices?/.test(banner), 1, banner)

  // ---- helpers ------------------------------------------------------------------------------
  const container = frame.locator('.leaflet-container').first()
  const box = await container.boundingBox()
  const clickEmptyMap = async () => { await page.mouse.click(box.x + 12, box.y + box.height - 12); await sleep(600) }
  const menuLabels = () => frame.locator('.layers-control-network label').allInnerTexts()
  const toggleMenuItem = async (prefix) => {
    const ctrl = frame.locator('.layers-control-network')
    if (!(await ctrl.evaluate((e) => e.classList.contains('leaflet-control-layers-expanded')))) {
      await frame.locator('.layers-control-network .leaflet-control-layers-toggle').click()
    }
    await frame.locator('.layers-control-network label', { hasText: prefix }).click()
    await sleep(700)
    await clickEmptyMap()
  }
  const tickedSeverities = async () => frame.locator('.layers-control-network label').evaluateAll((ls) =>
    ls.filter((l) => /^(Critical|Major|Minor) alarms/.test(l.innerText.trim()) && l.querySelector('input')?.checked)
      .map((l) => l.innerText.trim().split(' ')[0]))

  // Every cluster bubble's colour must be its worst member's colour. Also remembers each
  // bubble's worst member, so the popup checks pick a device by its data, not by a bubble
  // colour that may itself be the defect.
  let bubbleWorst = []
  const checkClusters = async (label) => {
    const seenWorst = []
    await clickEmptyMap()
    const n = await frame.locator('.device-cluster-bubble').count()
    let members = 0
    const bad = []
    for (let i = 0; i < n; i++) {
      const bubble = frame.locator('.device-cluster-bubble').nth(i)
      const text = await bubble.innerText()
      const shown = COLOR[await bubble.evaluate((b) => b.style.background)] ?? 'unrecognised'
      await frame.evaluate(() => document.querySelectorAll('.device-marker-dot').forEach((d) => { d.dataset.vb = '1' }))
      await bubble.click(); await sleep(900)
      const sevs = await frame.evaluate(() => [...document.querySelectorAll('.device-marker-dot:not([data-vb])')].map((d) => d.dataset.severity))
      members += sevs.length
      const expected = worst(sevs)
      seenWorst.push({ i, text, worst: expected })
      if (sevs.length !== Number(text)) bad.push(`bubble "${text}" opened ${sevs.length} markers`)
      else if (shown !== expected) bad.push(`bubble "${text}" is ${shown}, worst member is ${expected}`)
      await clickEmptyMap()
    }
    if (!bubbleWorst.length) bubbleWorst = seenWorst
    record(`cluster colours = worst member (${label})`, bad.length === 0, n, `${n} bubbles, ${members} members${bad.length ? '; ' + bad.join('; ') : ''}`)
  }

  const greyNow = await frame.evaluate(() => document.querySelectorAll('.device-marker-dot[data-severity="Unknown"]').length)
  const bubbleGrey = await frame.locator('.device-cluster-bubble').evaluateAll((bs) => bs.filter((b) => b.style.background === 'rgb(158, 158, 158)').length)
  const totalDots = await frame.locator('.device-marker-dot').count()
  const totalBubbles = await frame.locator('.device-cluster-bubble').count()
  record('no grey (unknown) markers or bubbles after load', greyNow === 0 && bubbleGrey === 0, totalDots + totalBubbles,
    `${greyNow} grey of ${totalDots} markers, ${bubbleGrey} grey of ${totalBubbles} bubbles`)

  await checkClusters(thresholdMode ? `ticked: ${(await tickedSeverities()).join('+') || 'none'}` : 'stable')

  // ---- Thresholds: menu counts vs independent recount, and tick effects --------------------
  // Recount from the most recent refresh only (its batches arrive within a few seconds of each
  // other); alarms reload every minute while this runs, so an older load would be another moment.
  const recountNow = () => {
    const lastT = alarmBodies.at(-1)?.t ?? 0
    const sevByDevice = new Map()
    let rows = 0
    for (const b of alarmBodies.filter((x) => lastT - x.t < 5000)) for (const a of b.rows ?? []) {
      if (a.ClearTime) continue
      const d = a.interface?.DeviceItemID ?? a.ItemID
      if (!alarmIds.has(d) || !(a.Severity in SEV_CODE)) continue
      rows++
      if (!sevByDevice.has(d)) sevByDevice.set(d, [])
      sevByDevice.get(d).push(SEV_CODE[a.Severity])
    }
    return { sevByDevice, rows }
  }
  if (thresholdMode) {
    const { sevByDevice, rows } = recountNow()
    const labels = await menuLabels()
    const bad = []
    for (const s of ['Critical', 'Major', 'Minor']) {
      const label = labels.find((l) => l.trim().startsWith(`${s} alarms`)) ?? ''
      const shown = Number(label.match(/\((\d+) device/)?.[1])
      const counted = [...sevByDevice.values()].filter((v) => v.includes(s)).length
      if (shown !== counted) bad.push(`${s}: menu ${shown}, recount ${counted}`)
    }
    record('menu counts = recount of the app\'s own alarm responses', bad.length === 0, rows,
      `${alarmBodies.length} responses so far, ${rows} alarm rows in the latest load, ${alarmIds.size} device ids; ${bad.join('; ') || labels.filter((l) => / alarms/.test(l)).map((l) => l.trim()).join(', ')}`)

    const before = await tickedSeverities()
    record('default ticks match alarms.severities', JSON.stringify(before) === JSON.stringify(config.alarms?.severities ?? ['Critical', 'Major']), 1,
      `ticked ${before.join('+')}, config ${JSON.stringify(config.alarms?.severities)}`)
    if (!before.includes('Minor')) {
      await toggleMenuItem('Minor alarms')
      await checkClusters('Minor also ticked')
      await toggleMenuItem('Minor alarms')
    }
    for (const s of before) await toggleMenuItem(`${s} alarms`)
    const none = await frame.locator('.device-marker-dot, .device-cluster-bubble').evaluateAll((es) =>
      es.filter((e) => (e.dataset.severity && e.dataset.severity !== 'Normal') || (e.style.background && e.style.background !== 'rgb(56, 142, 60)')).length)
    record('nothing ticked: everything green', none === 0, totalDots + totalBubbles, `${none} not green`)
    for (const s of before) await toggleMenuItem(`${s} alarms`)
    const after = await tickedSeverities()
    record('ticks restored', JSON.stringify(after) === JSON.stringify(before), 1, `now ${after.join('+')}`)
  }

  // ---- Popup in a spidered cluster: border, Alarms tab, links, Metrics, survives a refresh ----
  await clickEmptyMap()
  const bubbles = [...bubbleWorst].sort((a, b) => (RANK[b.worst] ?? 0) - (RANK[a.worst] ?? 0))
  if (!bubbles.length) {
    record('popup checks', false, 0, 'no cluster on the map to spider out')
  } else {
    await frame.evaluate(() => document.querySelectorAll('.device-marker-dot').forEach((d) => { d.dataset.vb = '1' }))
    const pick = frame.locator('.device-cluster-bubble', { hasText: new RegExp(`^${bubbles[0].text}$`) }).first()
    await pick.click(); await sleep(1000)
    const spidered = frame.locator('.device-marker-dot:not([data-vb])')
    const target = bubbles[0].worst
    const idx = await spidered.evaluateAll((ds, t) => Math.max(0, ds.findIndex((d) => d.dataset.severity === t)), target)
    const markerSev = await spidered.nth(idx).evaluate((d) => d.dataset.severity)
    await spidered.nth(idx).click({ force: true }); await sleep(700)
    const popup = frame.locator('.leaflet-popup')
    const tab = async (t) => { await popup.locator('.tab', { hasText: t }).click(); await sleep(400); return popup.locator('.tab-content').innerText() }
    const deviceName = (await tab('Site Info')).split('\n').find((l) => l.startsWith('Name'))?.replace('Name:', '').trim()
    const border = await popup.evaluate((p) => [...p.classList].find((c) => c.startsWith('popup-severity-')))
    record('popup border = marker severity', border === `popup-severity-${(markerSev === 'Unknown' ? 'normal' : markerSev).toLowerCase()}`, 1, `${deviceName}: marker ${markerSev}, border ${border}`)

    const alarmsText = await tab('Alarms')
    const triage = await popup.locator('.triage-jump a').count()
    record('Triage link present iff triageViewPageId is set', (triage > 0) === (config.triageViewPageId != null) || alarmsText.startsWith('No '), 1,
      `triageViewPageId=${config.triageViewPageId}, links=${triage}`)

    if (thresholdMode) {
      const rowsShown = await popup.locator('.alarm-item').evaluateAll((lis) => lis.map((li) => ({
        sev: li.querySelector('.alarm-severity')?.innerText.trim(),
        iface: li.querySelector('.alarm-component')?.innerText.replace('Interface · ', '').trim() ?? null,
        href: li.querySelector('.alarm-link')?.getAttribute('href') ?? null,
      })))
      const ticked = await tickedSeverities()
      const offTick = rowsShown.filter((r) => ['Critical', 'Major', 'Minor'].includes(r.sev) && !ticked.includes(r.sev))
      record('Alarms tab lists only ticked severities', offTick.length === 0, rowsShown.length, `${rowsShown.length} rows, ${offTick.length} off-tick`)
      const hiddenNote = alarmsText.match(/^(.*) alarms? hidden/m)?.[1] ?? ''
      const hiddenShown = [...hiddenNote.matchAll(/(\d+) (Critical|Major|Minor)/g)].reduce((n, m) => n + Number(m[1]), 0)
      const badLinks = rowsShown.filter((r) => !r.href || !/^\/pc\/redirector\?ItemID=\d+$/.test(r.href))
      record('every alarm row links to a redirector GlobalID', badLinks.length === 0, rowsShown.length, `${badLinks.length} bad of ${rowsShown.length}`)
      const firstIface = rowsShown.findIndex((r) => r.iface && r.href)
      if (firstIface >= 0) {
        const [t] = await Promise.all([page.context().waitForEvent('page'), popup.locator('.alarm-item').nth(firstIface).locator('.alarm-link').click()])
        await t.waitForLoadState('domcontentloaded'); await t.waitForTimeout(6000)
        const body = await t.locator('body').innerText()
        const want = rowsShown[firstIface].iface
        record('interface link opens that interface', body.includes(`Interface: ${want}`) && (!deviceName || body.includes(deviceName)), 1, `${want} → ${body.split('\n').filter((l) => /^(Router|Interface|Switch|Device):/.test(l)).join(' › ') || t.url()}`)
        await t.close()
      } else record('interface link opens that interface', false, 0, 'no interface alarm on this device')
      // Expected hidden = this device's alarms of unticked severities, from the independent recount.
      const ids = await frame.evaluate(async (name) => {
        const r = await fetch(`/pc/odata4/api/devices?$filter=${encodeURIComponent(`Name eq '${name.replace(/'/g, "''")}'`)}&$select=ID&$format=application/json`)
        return r.ok ? (await r.json()).value.map((d) => d.ID) : []
      }, deviceName ?? '')
      const recount = recountNow().sevByDevice
      const id = ids.find((i) => recount.has(i)) ?? ids[0]
      const expectedHidden = (recount.get(id) ?? []).filter((s) => !ticked.includes(s)).length
      record('hidden-alarm note = recount of unticked alarms', ids.length > 0 && hiddenShown === expectedHidden, ids.length,
        `device id ${id}: note "${hiddenNote || 'none'}" = ${hiddenShown}, recount ${expectedHidden}`)
    }
    if (triage > 0) {
      const [t] = await Promise.all([page.context().waitForEvent('page'), popup.locator('.triage-jump a').first().click()])
      await t.waitForLoadState('domcontentloaded'); await t.waitForTimeout(6000)
      const body = await t.locator('body').innerText()
      record('Triage link opens this device\'s Triage View', body.includes('Triage View') && (!deviceName || body.includes(deviceName)), 1, `${deviceName} → ${(await t.title())}`)
      await t.close()
    }

    const metrics = await tab('Metrics')
    const wanGroup = config.metrics?.wanGroup ?? null
    const want = config.metrics?.profile !== 'network' ? ['CPU Utilization', 'Memory Utilization']
      : wanGroup != null ? ['WAN circuits'] : ['Bandwidth In', 'Bandwidth Out']
    const missing = want.filter((w) => !metrics.includes(w))
    const avail = config.metrics?.profile !== 'network' || /Availability|Reachability/.test(metrics)
    record('Metrics tab lines present', missing.length === 0 && avail, want.length, `missing: ${missing.join(', ') || 'none'}${config.metrics?.profile === 'network' && wanGroup == null ? `; busiest line: ${metrics.includes('Busiest interface') ? 'yes' : 'no'}` : ''}`)

    // WAN circuits (metrics.wanGroup): the popup's circuit lines = this device's members of the group,
    // counted by an independent query (by device id — PC ignores device/groups/any silently).
    if (config.metrics?.profile === 'network' && wanGroup != null) {
      const shown = await popup.locator('.wan-circuit').count()
      const indep = await frame.evaluate(async ({ group, name }) => {
        const get = async (u) => { const r = await fetch(u); return r.ok ? (await r.json()).value : null }
        let id = typeof group === 'number' ? group : null
        if (id == null) {
          const g = await get(`/pc/odata4/api/groups?$filter=${encodeURIComponent(`Name eq '${String(group).trim().replace(/'/g, "''")}'`)}&$select=ID&$format=application/json`)
          id = g?.length === 1 ? g[0].ID : null
        }
        const d = await get(`/pc/odata4/api/devices?$filter=${encodeURIComponent(`Name eq '${name.replace(/'/g, "''")}'`)}&$select=ID&$format=application/json`)
        if (id == null || !d?.length) return { error: `group ${id}, devices ${d?.length}` }
        const counts = []
        for (const dev of d) {
          const m = await get(`/pc/odata4/api/interfaces?$filter=${encodeURIComponent(`groups/any(L1:L1/ID eq ${id}) and DeviceItemID eq ${dev.ID}`)}&$select=ID&$top=1000&$format=application/json`)
          counts.push(m?.length ?? -1)
        }
        return { group: id, counts }
      }, { group: wanGroup, name: deviceName ?? '' })
      const expected = indep.counts ? Math.max(...indep.counts) : null
      const noneText = /WAN circuits:\s*none on this device/.test(metrics)
      record('WAN circuit lines = the device\'s members of the WAN group', !indep.error && (shown === expected || (expected === 0 && noneText)), 1,
        indep.error ? `independent query failed: ${indep.error}` : `${deviceName}: ${shown} lines shown, ${expected} members of group ${indep.group}`)
    }

    // Survives the next refresh (threshold alarms or tunnels, whichever polls).
    const refreshMs = (thresholdMode ? config.alarms?.refreshIntervalMs : config.tunnels?.refreshIntervalMs) ?? 60000
    const polled = thresholdMode ? '/pc/odata4/api/activealarms' : '/pc/odata4/api/sdntunnels'
    const t0 = Date.now()
    const seen = await page.waitForRequest((r) => r.url().includes(polled), { timeout: refreshMs + 20000 }).then(() => true, () => false)
    await sleep(4000)
    const still = await popup.count()
    const stillName = still ? (await popup.locator('.tab-content').innerText()).length > 0 : false
    record('popup in a spidered cluster survives a refresh', seen && still === 1 && stillName, seen ? 1 : 0,
      `${seen ? `refresh after ${Math.round((Date.now() - t0) / 1000)} s` : 'no refresh seen'}; popup ${still ? 'open' : 'CLOSED'}`)
  }

  // WAN circuits on a device that HAS some (the popup device above may have none): open the
  // standalone markers until one lists circuits, and compare its lines with an independent count.
  if (config.metrics?.profile === 'network' && config.metrics?.wanGroup != null) {
    await clickEmptyMap()
    const dots = frame.locator('.device-marker-dot')
    let done = false
    for (let i = 0; i < Math.min(await dots.count(), 12) && !done; i++) {
      await dots.nth(i).click({ force: true }); await sleep(500)
      const popup = frame.locator('.leaflet-popup')
      const name = (await popup.locator('.tab-content').innerText().catch(() => '')).split('\n').find((l) => l.startsWith('Name'))?.replace('Name:', '').trim()
      await popup.locator('.tab', { hasText: 'Metrics' }).click(); await sleep(500)
      const lines = await popup.locator('.wan-circuit').evaluateAll((ls) => ls.map((l) => l.innerText.replace(/\s+/g, ' ').trim()))
      if (lines.length > 0 && name) {
        const indep = await frame.evaluate(async ({ group, name }) => {
          const get = async (u) => { const r = await fetch(u); return r.ok ? (await r.json()).value : null }
          let id = typeof group === 'number' ? group : null
          if (id == null) {
            const g = await get(`/pc/odata4/api/groups?$filter=${encodeURIComponent(`Name eq '${String(group).trim().replace(/'/g, "''")}'`)}&$select=ID&$format=application/json`)
            id = g?.length === 1 ? g[0].ID : null
          }
          const d = await get(`/pc/odata4/api/devices?$filter=${encodeURIComponent(`Name eq '${name.replace(/'/g, "''")}'`)}&$select=ID&$format=application/json`)
          if (id == null || !d?.length) return { error: true }
          const m = await get(`/pc/odata4/api/interfaces?$filter=${encodeURIComponent(`groups/any(L1:L1/ID eq ${id}) and DeviceItemID eq ${d[0].ID}`)}&$select=Name&$top=1000&$format=application/json`)
          return { names: (m ?? []).map((x) => x.Name).sort() }
        }, { group: config.metrics.wanGroup, name })
        const shownNames = lines.map((l) => l.split(' ')[0]).sort()
        const same = !indep.error && JSON.stringify(shownNames) === JSON.stringify(indep.names)
        record('WAN circuits listed = the group\'s members on a device that has them', same, lines.length,
          `${name}: shown [${shownNames.join(', ')}], group members [${(indep.names ?? []).join(', ')}]`)
        done = true
      }
      await clickEmptyMap()
    }
    if (!done) record('WAN circuits listed = the group\'s members on a device that has them', false, 0, 'no standalone marker lists any WAN circuit — is the group right?')
  }

  page.off('response', onResponse)
  const failed = results.filter((r) => !r.pass)
  return {
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    summary: `${results.length - failed.length} of ${results.length} checks passed`,
    app, bundle, mode: thresholdMode ? 'thresholds' : 'stable', group: frame.url().match(/[?&]id=(\d+)/)?.[1],
    results: results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.check}  [${r.inspected}]  ${r.detail}`),
  }
}
