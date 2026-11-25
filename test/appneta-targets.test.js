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
import { targetRecordsByName, targetPopupRows, anchorSharesMpSpot, groupBySpot } from '../src/lib/appnetaTargets.js'

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

// A target globe at the same spot as a monitoring point used to cover the MP's bullseye completely (same
// z-index, drawn later), so the MP could not be seen or clicked: 6 of 7 on a lab Portal, all but the one MP
// with no target in its city. Coordinates are REAL: test/fixtures/appneta-mp-target-coords.json.
describe('anchorSharesMpSpot', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/appneta-mp-target-coords.json', import.meta.url)))
  const anchorAt = (lat, lng) => ({ lat, lng })
  const byLocality = new Map(fx.targets.map((t) => [t.locality, anchorAt(t.targetLat, t.targetLng)]))

  test('every captured city globe sits on an MP (6 of 6)', () => {
    const cities = [...byLocality.keys()].sort()
    assert.deepEqual(cities, ['Chicago', 'Houston', 'Miami', 'New York', 'San Francisco', 'Seattle'])
    for (const c of cities) assert.equal(anchorSharesMpSpot(byLocality.get(c), fx.mps), true, c)
  })

  test('a globe with no MP nearby is not moved', () => {
    // Denver's MP has no target in Denver; a globe there would be alone. Use a spot 1 degree away from any MP.
    assert.equal(anchorSharesMpSpot(anchorAt(39.739235 + 1, -104.99025), fx.mps), false)
  })

  test('an MP in the next town (Long Island, ~0.6 deg from New York) does not count', () => {
    const others = fx.mps.filter((m) => m.name !== 'MP-NewYork' && !m.name.startsWith('MP-SanFrancisco'))
    assert.equal(anchorSharesMpSpot(byLocality.get('New York'), others), false)
  })

  test('no MPs, or MPs without coordinates: never moved', () => {
    assert.equal(anchorSharesMpSpot(byLocality.get('Miami'), []), false)
    assert.equal(anchorSharesMpSpot(byLocality.get('Miami'), [{ name: 'x', latitude: null, longitude: null }]), false)
  })
})

// Markers at the same spot are drawn as one: otherwise the later one covers the earlier completely (two MPs with
// identical coordinates; a city's paths whose AppNeta coordinates differ by ~600 m, so its 13-path globe sat
// under a 2-path one). Coordinates are REAL: the 'sameSpot' part of the fixture.
describe('groupBySpot', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/appneta-mp-target-coords.json', import.meta.url)))
  const mpGroups = (mps) => groupBySpot(mps, (m) => m.latitude, (m) => m.longitude)
  const pathGroups = (ps) => groupBySpot(ps, (p) => p.targetLat, (p) => p.targetLng)
  const chicago = fx.sameSpot.chicagoPaths.flatMap((t, i) =>
    Array.from({ length: t.count }, (_, k) => ({ id: `${i}-${k}`, target: t.target, targetLat: t.targetLat, targetLng: t.targetLng })))

  test('two MPs with identical coordinates become one group of 2', () => {
    const g = mpGroups(fx.sameSpot.mps)
    assert.equal(g.length, 1)
    assert.deepEqual(g[0].items.map((m) => m.name), ['MP-NewYork-A', 'MP-NewYork-B'])
  })

  test("a city's 15 paths, 2 of them ~600 m off, make one globe with all 15", () => {
    assert.equal(chicago.length, 15)
    const g = pathGroups(chicago)
    assert.equal(g.length, 1)
    assert.equal(g[0].items.length, 15)
    // Drawn at the first path's point.
    assert.deepEqual([g[0].lat, g[0].lng], [41.878113, -87.6298])
  })

  test('different cities stay apart (11 MPs at 10 spots: the two San Francisco MPs share one)', () => {
    const g = mpGroups(fx.mps)
    assert.equal(g.length, 10)
    const sf = g.find((x) => x.items.length === 2)
    assert.deepEqual(sf.items.map((m) => m.name).sort(), ['MP-SanFrancisco', 'MP-SanFrancisco-EXT'])
    // New York and Long Island (~0.6 deg apart) are separate.
    assert.ok(g.some((x) => x.items.length === 1 && x.items[0].name === 'MP-NewYork'))
    assert.ok(g.some((x) => x.items.length === 1 && x.items[0].name === 'MP-LongIsland'))
  })

  test('the 14 captured targets make 6 city globes', () => {
    assert.equal(pathGroups(fx.targets).length, 6)
  })

  test('empty input gives no groups; items without coordinates are left out', () => {
    assert.deepEqual(groupBySpot([], (m) => m.latitude, (m) => m.longitude), [])
    assert.deepEqual(mpGroups([{ name: 'x', latitude: null, longitude: 1 }]), [])
  })
})
