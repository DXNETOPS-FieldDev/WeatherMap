// Unit tests for the drill-down links in an AppNeta target popup (src/lib/appnetaTargets.js) — run with `npm test`.
//
// v1.1.4 hides AppNeta path targets from the device markers, which also took away their link to PC's
// "Monitored Target" page. The target popup gives it back, and lists each path ending there with a link to
// its PC path page. Fixtures are REAL: test/fixtures/appneta-target-paths.json (the 15 paths ending at one
// globe on dev, with their DA LocalIDs) and test/fixtures/devices-polled.csv (devices-query rows).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Papa from 'papaparse'
import { normalizeDevice } from '../src/api/odata.js'
import { targetRecordsByName, targetPopupRows } from '../src/lib/appnetaTargets.js'

const raw = JSON.parse(readFileSync(new URL('./fixtures/appneta-target-paths.json', import.meta.url))).paths
// The fields fetchAppNetaPaths + the DA join give each path (src/api/appneta.js normalize, App.jsx localId).
const paths = raw.map((p) => ({ id: p.id, sourceName: p.sourceAppliance, target: p.target, localId: p.localId }))
const csv = readFileSync(new URL('./fixtures/devices-polled.csv', import.meta.url), 'utf8')
const devices = Papa.parse(csv, { header: true, dynamicTyping: true, skipEmptyLines: true }).data.map(normalizeDevice)

describe('targetRecordsByName', () => {
  const byName = targetRecordsByName(devices)

  test('keeps the AppNeta records (targets and monitoring points), by name', () => {
    assert.equal(byName.get('seattle-isp-2').globalId, 84983)
    assert.equal(byName.get('vk35-seattle-appneta').globalId, 84987)
    assert.equal(byName.get('web.example.com').globalId, 175183)
  })

  test('real devices are not in it', () => {
    assert.equal(byName.has('router-2.example.com'), false)
    assert.equal(byName.has('cluster01-vrops1'), false)
    assert.equal(byName.size, 3)
  })

  test('two records with the same name: neither is used, since we cannot tell which one is current', () => {
    const dup = { ...devices.find((d) => d.name === 'seattle-isp-2'), id: 1, globalId: 1 }
    assert.equal(targetRecordsByName([...devices, dup]).has('seattle-isp-2'), false)
  })
})

describe('targetPopupRows (the 15 real paths ending at Seattle)', () => {
  const rows = targetPopupRows(paths, targetRecordsByName(devices))
  const row = (t) => rows.find((r) => r.target === t)

  test('one row per target, sorted, holding all 15 paths', () => {
    assert.deepEqual(rows.map((r) => r.target), ['seattle-isp-1', 'seattle-isp-2', 'shop.example.com', 'vk35-seattle-appneta'])
    assert.deepEqual(rows.map((r) => r.paths.length), [5, 5, 3, 2])
  })

  test('a target with a PC record links to its PC page (what its device marker linked to before)', () => {
    assert.equal(row('seattle-isp-2').href, '/pc/redirector?ItemID=84983')
    assert.equal(row('vk35-seattle-appneta').href, '/pc/redirector?ItemID=84987')
  })

  test('a target with no PC record in this group is listed without a link', () => {
    assert.equal(row('seattle-isp-1').href, null)
  })

  test('each path links to its PC path page, labelled "source → target", sorted by source', () => {
    const p = row('seattle-isp-2').paths
    assert.deepEqual(p.map((x) => x.label), [
      'MP-Chicago → seattle-isp-2', 'MP-Houston → seattle-isp-2', 'MP-Miami → seattle-isp-2',
      'MP-NewYork → seattle-isp-2', 'MP-SanFran → seattle-isp-2',
    ])
    assert.equal(p[0].href, '/pc/redirector?SourceType=262144&LocalID=229655')
  })

  test('a path the DA could not map (no LocalID) is listed without a link', () => {
    const noDa = paths.map((x) => (x.id === 308171 ? { ...x, localId: null } : x))
    const p = targetPopupRows(noDa, new Map()).find((r) => r.target === 'seattle-isp-2').paths
    assert.equal(p.find((x) => x.label.startsWith('MP-Chicago')).href, null)
    assert.equal(p.find((x) => x.label.startsWith('MP-Miami')).href, '/pc/redirector?SourceType=262144&LocalID=229657')
  })

  test('no paths, no rows', () => {
    assert.deepEqual(targetPopupRows([], new Map()), [])
  })
})
