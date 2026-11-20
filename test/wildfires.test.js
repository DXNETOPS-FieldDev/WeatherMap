// Unit tests for the Wildfires layer (src/api/wildfires.js, src/lib/geo.js) — run with `npm test`.
//
// The parsing tests use REAL NIFC WFIGS responses captured 2026-11-20 (test/fixtures/nifc-*.json, trimmed to a
// few unedited features). The correlation tests use small synthetic squares so the expected answer is obvious.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseWildfires, correlateWildfiresToDevices, bannerFireCount, fetchAllPages } from '../src/api/wildfires.js'
import { haversineMiles, distanceToGeometryMiles } from '../src/lib/geo.js'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))).response
const perimeters = fixture('nifc-perimeters.json')
const incidents = fixture('nifc-incidents.json')

const MILES_PER_DEG_LAT = 69.09   // haversine with the mean Earth radius
const square = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] })
const fire = (id, { perimeter = null, point = null, name = id } = {}) => ({ id, name, perimeter, point })
const device = (id, longitude, latitude) => ({ id, longitude, latitude })

describe('parseWildfires (real NIFC responses)', () => {
  const fires = parseWildfires(perimeters, incidents)
  const byName = new Map(fires.map((f) => [f.name, f]))

  test('one fire per wildfire: 4 with a perimeter, 3 without, 1 complex = 8', () => {
    assert.equal(fires.length, 8)
  })

  test('prescribed burns (RX) are left out', () => {
    assert.equal(fires.some((f) => /BEAR WALLOW/i.test(f.name)), false)
  })

  test('a perimeter and its incident (same IRWIN id, any case/braces) are one fire with both', () => {
    const t = byName.get('Tedford')
    assert.ok(t, 'Tedford present')
    assert.equal(t.perimeter.type, 'MultiPolygon')
    assert.deepEqual(t.point, [-87.4709441162345, 34.3408264387825])
    assert.equal(fires.filter((f) => /tedford/i.test(f.name)).length, 1)
  })

  test('the perimeter name and mapped acres win over the incident record', () => {
    assert.ok(byName.has('Anglers Ave'), 'perimeter name, not the incident\'s "Angler"')
    assert.equal(byName.get('Anglers Ave').acres, 1.5)
    assert.ok(byName.has('Robbins Branch'), 'not "ROBBINS BRANCH"')
  })

  test('a fire without a perimeter keeps its incident point and size', () => {
    const q = byName.get('Qury')
    assert.equal(q.perimeter, null)
    assert.deepEqual(q.point, [-103.566737305631, 43.7481260536149])
    assert.equal(q.acres, 9168)
    assert.equal(q.contained, 100)
    assert.equal(q.state, 'SD')
  })

  test('a complex (CX) is a wildfire', () => {
    assert.ok(byName.has('HAY CREEK COMPLEX'))
  })

  test('dates are kept as epoch ms; missing numbers stay null, not 0', () => {
    const m = byName.get('Moonlight Farm')
    assert.equal(m.acres, null)
    assert.equal(m.contained, null)
    assert.equal(typeof m.discoveredAt, 'number')
    assert.equal(typeof m.updatedAt, 'number')
  })

  test('empty or malformed responses give no fires rather than throwing', () => {
    assert.deepEqual(parseWildfires(null, null), [])
    assert.deepEqual(parseWildfires({ features: 'x' }, {}), [])
  })
})

describe('distance helpers', () => {
  test('one degree of latitude is about 69 miles', () => {
    assert.ok(Math.abs(haversineMiles([0, 0], [0, 1]) - MILES_PER_DEG_LAT) < 0.1)
  })

  test('distance to a polygon is to its nearest edge, 0 inside', () => {
    const sq = square(0, 0, 1, 1)
    assert.equal(distanceToGeometryMiles([0.5, 0.5], sq), 0)
    const d = distanceToGeometryMiles([0.5, 1.1], sq)   // 0.1° north of the top edge
    assert.ok(Math.abs(d - 0.1 * MILES_PER_DEG_LAT) < 0.2, `got ${d}`)
  })
})

describe('correlateWildfiresToDevices', () => {
  const sq = square(0, 0, 1, 1)

  test('a device inside a perimeter is "inside"', () => {
    const r = correlateWildfiresToDevices([device(1, 0.5, 0.5)], [fire('a', { perimeter: sq })], 0).get(1)
    assert.equal(r.kind, 'inside')
    assert.equal(r.fire.id, 'a')
    assert.equal(r.miles, 0)
  })

  test('nearbyMiles 0 (the default) flags only devices inside, like Power Outages', () => {
    const m = correlateWildfiresToDevices([device(1, 0.5, 1.05)], [fire('a', { perimeter: sq })], 0)
    assert.equal(m.has(1), false)
  })

  test('within N miles of the perimeter edge is "nearby", with the distance', () => {
    const r = correlateWildfiresToDevices([device(1, 0.5, 1.05)], [fire('a', { perimeter: sq })], 10).get(1)
    assert.equal(r.kind, 'nearby')
    assert.ok(Math.abs(r.miles - 0.05 * MILES_PER_DEG_LAT) < 0.2, `got ${r.miles}`)
  })

  test('beyond N miles is not flagged', () => {
    const m = correlateWildfiresToDevices([device(1, 0.5, 1.5)], [fire('a', { perimeter: sq })], 10)
    assert.equal(m.has(1), false)
  })

  test('the perimeter edge counts, not a far-away incident point', () => {
    const f = fire('a', { perimeter: sq, point: [0.5, 0.5] })   // origin point in the middle of the fire
    const r = correlateWildfiresToDevices([device(1, 0.5, 1.05)], [f], 10).get(1)
    assert.ok(r.miles < 5, `edge is ~3.5 mi away, the point ~38 mi; got ${r.miles}`)
  })

  test('a fire without a perimeter is measured from its point', () => {
    const r = correlateWildfiresToDevices([device(1, 0, 0.1)], [fire('p', { point: [0, 0] })], 10).get(1)
    assert.equal(r.kind, 'nearby')
    assert.ok(Math.abs(r.miles - 0.1 * MILES_PER_DEG_LAT) < 0.2)
  })

  test('inside beats a nearer-looking nearby fire, and the nearest nearby wins', () => {
    const inside = fire('in', { perimeter: sq })
    const near = fire('near', { point: [0.5, 0.5] })
    assert.equal(correlateWildfiresToDevices([device(1, 0.5, 0.5)], [near, inside], 10).get(1).fire.id, 'in')
    const a = fire('a', { point: [0, 0.1] }), b = fire('b', { point: [0, 0.05] })
    // Both orders, so "the last one in range" can't pass for "the nearest".
    assert.equal(correlateWildfiresToDevices([device(1, 0, 0)], [a, b], 10).get(1).fire.id, 'b')
    assert.equal(correlateWildfiresToDevices([device(1, 0, 0)], [b, a], 10).get(1).fire.id, 'b')
  })

  test('devices without usable coordinates are skipped', () => {
    const m = correlateWildfiresToDevices([device(1, NaN, 0), device(2, null, null)], [fire('a', { perimeter: sq })], 10)
    assert.equal(m.size, 0)
  })

  test('a negative or non-numeric nearbyMiles is treated as off', () => {
    for (const n of [-5, 'ten', undefined, null]) {
      assert.equal(correlateWildfiresToDevices([device(1, 0.5, 1.05)], [fire('a', { perimeter: sq })], n).has(1), false, String(n))
    }
  })
})

describe('bannerFireCount (the "Wildfires (N)" label)', () => {
  test('counts distinct fires shown in device banners', () => {
    const a = { id: 'a' }, b = { id: 'b' }
    const devices = [{ wildfire: { fire: a } }, { wildfire: { fire: a } }, { wildfire: { fire: b } }, { wildfire: null }, {}]
    assert.equal(bannerFireCount(devices), 2)
  })
  test('no devices, no fires', () => {
    assert.equal(bannerFireCount([]), 0)
    assert.equal(bannerFireCount(undefined), 0)
  })
})

describe('fetchAllPages (NIFC paging)', () => {
  const truncated = fixture('nifc-page-truncated.json')   // real: properties.exceededTransferLimit = true

  test('follows exceededTransferLimit with resultOffset until a page is not truncated', async () => {
    const urls = []
    const last = { type: 'FeatureCollection', features: [{ id: 'z' }] }   // a final page has no exceededTransferLimit
    const fakeFetch = async (url) => {
      urls.push(url)
      return { ok: true, json: async () => (urls.length === 1 ? truncated : last) }
    }
    const features = await fetchAllPages('https://x/query', { where: '1=1' }, fakeFetch)
    assert.equal(features.length, truncated.features.length + 1)
    assert.match(urls[0], /resultOffset=0/)
    assert.match(urls[1], new RegExp(`resultOffset=${truncated.features.length}`))
  })

  test('an HTTP error is thrown, so the caller can keep the map working', async () => {
    await assert.rejects(fetchAllPages('https://x/query', {}, async () => ({ ok: false, status: 503 })), /503/)
  })

  test('stops after a safety cap even if the server keeps saying "more"', async () => {
    let n = 0
    const always = async () => { n++; return { ok: true, json: async () => truncated } }
    await fetchAllPages('https://x/query', {}, always, { maxPages: 3 })
    assert.equal(n, 3)
  })
})

describe('fireFacts / distanceText (banner and popup wording)', async () => {
  const { fireFacts, distanceText } = await import('../src/api/wildfires.js')
  const day = Date.UTC(2026, 10, 19, 12, 0)

  test('title is the name with the state; size line shows acres and containment', () => {
    const f = fireFacts({ name: 'Tedford', state: 'AL', acres: 1234.6, contained: 45, discoveredAt: day, updatedAt: day })
    assert.equal(f.title, 'Tedford (AL)')
    assert.equal(f.size, '1,235 acres · 45% contained')
    assert.match(f.dates, /^Discovered .+ · updated .+$/)
  })

  test('unknown numbers are left out, not shown as 0', () => {
    const f = fireFacts({ name: 'Moonlight Farm', state: 'PR', acres: null, contained: null, discoveredAt: null, updatedAt: null })
    assert.equal(f.size, null)
    assert.equal(f.dates, null)
    assert.equal(fireFacts({ name: 'X', state: null, acres: 0.4, contained: 0 }).size, 'less than 1 acre · 0% contained')
  })

  test('distance wording', () => {
    assert.equal(distanceText(0.4), 'less than 1 mi')
    assert.equal(distanceText(7.6), 'about 8 mi')
  })
})
