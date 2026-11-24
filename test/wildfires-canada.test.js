// Unit tests for Canadian wildfires (src/api/wildfires-canada.js) and the two-source fetch in
// src/api/wildfires.js — run with `npm test`.
//
// Parsing uses the REAL CWFIS response captured 2026-11-23 (test/fixtures/cwfis-activefires.json, complete and
// unedited: 90 current fires). Fetch tests use a stub fetch so the URLs and paging can be asserted.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseCanadaFires, canadaQueryUrl, fetchCanadaFires, recentCanadaFires } from '../src/api/wildfires-canada.js'
import { fetchWildfires, fireFacts, fireSource, correlateWildfiresToDevices } from '../src/api/wildfires.js'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))).response
const cwfis = fixture('cwfis-activefires.json')
const nifcIncidents = fixture('nifc-incidents.json')

const BASE = 'https://geoserver.cwfif.nrcan.gc.ca/geoserver/public/wfs'
const NOW = new Date('2026-11-23T23:50:00Z')
const okJson = (body) => ({ ok: true, status: 200, json: async () => body })

describe('parseCanadaFires (real CWFIS response)', () => {
  const fires = parseCanadaFires(cwfis)
  const byNational = new Map(fires.map((f) => [f.id, f]))

  test('one fire per record: 90, ids unique', () => {
    assert.equal(fires.length, 90)
    assert.equal(new Set(fires.map((f) => f.id)).size, 90)
  })

  test('a small New Brunswick fire: name, agency, point, hectares and acres, stage, date', () => {
    const f = byNational.get('cwfis-2026_NB_2026396')
    assert.ok(f, 'NB fire present')
    assert.equal(f.source, 'CWFIS')
    assert.equal(f.name, 'Fire 2026396')
    assert.equal(f.state, 'NB')
    assert.deepEqual(f.point, [-64.6956, 45.7418])   // GeoJSON order: lon, lat
    assert.equal(f.perimeter, null)
    assert.equal(f.hectares, 0.2)
    assert.ok(Math.abs(f.acres - 0.494) < 0.001)
    assert.equal(f.stage, 'Under control')
    assert.equal(f.updatedAt, Date.parse('2026-11-22T16:50:00Z'))
  })

  test('percent_contained -1 (unknown) becomes null, never 0 or -1', () => {
    assert.ok(fires.every((f) => f.contained === null))
  })

  test('no discovery date in this feed: null', () => {
    assert.ok(fires.every((f) => f.discoveredAt === null))
  })

  test('stages map to words: 47 out of control, 3 being held, 40 under control', () => {
    const count = (s) => fires.filter((f) => f.stage === s).length
    assert.equal(count('Out of control'), 47)
    assert.equal(count('Being held'), 3)
    assert.equal(count('Under control'), 40)
  })

  test('Parks Canada fires read "Parks Canada", not "PC"', () => {
    const pc = fires.filter((f) => f.state === 'Parks Canada')
    assert.equal(pc.length, 17)
    assert.equal(fires.some((f) => f.state === 'PC'), false)
  })

  test('a record without a usable point is dropped; empty or missing input gives []', () => {
    const broken = { features: [{ type: 'Feature', geometry: null, properties: cwfis.features[0].properties }] }
    assert.deepEqual(parseCanadaFires(broken), [])
    assert.deepEqual(parseCanadaFires(null), [])
    assert.deepEqual(parseCanadaFires({}), [])
  })
})

describe('recentCanadaFires: 30-day cutoff', () => {
  // Most "current" CWFIS records are fires agencies only monitor and never close: 66 of the 90 were last
  // updated over 90 days before the capture, some in 2020. A banner saying "Active wildfire" for those misleads.
  const fires = parseCanadaFires(cwfis)
  const DAY = 24 * 3600 * 1000

  test('the real response: 9 of 90 were updated within 30 days', () => {
    const kept = recentCanadaFires(fires, NOW.getTime())
    assert.equal(kept.length, 9)
    assert.ok(kept.every((f) => NOW.getTime() - f.updatedAt <= 30 * DAY))
  })

  test('the Seattle-area BC fire (last updated Sep 29) is dropped', () => {
    assert.equal(recentCanadaFires(fires, NOW.getTime()).some((f) => f.id === 'cwfis-2026_BC_2026-V62262'), false)
  })

  test('boundary: exactly 30 days kept, 30 days and 1 minute dropped', () => {
    const t = NOW.getTime()
    const kept = recentCanadaFires([{ id: 'a', updatedAt: t - 30 * DAY }, { id: 'b', updatedAt: t - 30 * DAY - 60000 }], t)
    assert.deepEqual(kept.map((f) => f.id), ['a'])
  })

  test('no update date: dropped (its age is unknown)', () => {
    assert.deepEqual(recentCanadaFires([{ id: 'x', updatedAt: null }], NOW.getTime()), [])
  })
})

describe('fireFacts and fireSource for Canadian fires', () => {
  const fires = parseCanadaFires(cwfis)
  const big = fires.find((f) => f.id === 'cwfis-2026_ON_THU_FIRE_036')

  test('size in hectares with acres in brackets, then the stage', () => {
    const f = fireFacts(big)
    assert.equal(f.title, 'Fire THU_FIRE_036 (ON)')
    assert.equal(f.size, '301,240 ha (744,380 acres) · Under control')
  })

  test('a fire under 1 ha says so rather than "0 ha"', () => {
    const f = fireFacts(fires.find((x) => x.id === 'cwfis-2026_NB_2026396'))
    assert.equal(f.size, 'less than 1 ha · Under control')
  })

  test('dates: only "Updated" (no discovery date)', () => {
    assert.match(fireFacts(big).dates, /^Updated Sep 17, 2026$/)
  })

  test('source names: CWFIS for Canada, NIFC for the US', () => {
    assert.equal(fireSource(big), 'CWFIS (Canada)')
    assert.equal(fireSource({ source: 'NIFC' }), 'NIFC')
  })

  test('US fires still show acres only', () => {
    assert.equal(fireFacts({ name: 'X', state: 'CA', acres: 1200, contained: 40, source: 'NIFC' }).size,
      '1,200 acres · 40% contained')
  })
})

describe('correlation with Canadian (point-only) fires', () => {
  const fires = parseCanadaFires(cwfis)
  const moncton = { id: 'd1', longitude: -64.78, latitude: 46.09 }   // ~24 mi from the NB fire

  test('nothing is flagged when nearbyMiles is 0: points have no perimeter to be inside', () => {
    assert.equal(correlateWildfiresToDevices([moncton], fires, 0).size, 0)
  })

  test('within nearbyMiles: flagged "nearby" with the distance', () => {
    const hit = correlateWildfiresToDevices([moncton], fires, 50).get('d1')
    assert.ok(hit)
    assert.equal(hit.kind, 'nearby')
    assert.equal(hit.fire.id, 'cwfis-2026_NB_2026396')
    assert.ok(hit.miles > 20 && hit.miles < 30, `miles ${hit.miles}`)
  })
})

describe('canadaQueryUrl', () => {
  const u = new URL(canadaQueryUrl(BASE, NOW, 0, 5000))

  test('WFS GetFeature for the national active fires layer, GeoJSON in lat/lon', () => {
    assert.equal(u.origin + u.pathname, BASE)
    assert.equal(u.searchParams.get('request'), 'GetFeature')
    assert.equal(u.searchParams.get('typeNames'), 'public:cwfif_national_activefires')
    assert.equal(u.searchParams.get('outputFormat'), 'application/json')
    assert.equal(u.searchParams.get('srsName'), 'EPSG:4326')
  })

  test('only records current at "now" (without it the layer returns its whole history)', () => {
    assert.equal(u.searchParams.get('CQL_FILTER'),
      "record_start<='2026-11-23T23:50:00Z' AND record_end>'2026-11-23T23:50:00Z'")
  })

  test('paging parameters with a stable order', () => {
    const p = new URL(canadaQueryUrl(BASE, NOW, 5000, 5000)).searchParams
    assert.equal(p.get('startIndex'), '5000')
    assert.equal(p.get('count'), '5000')
    assert.equal(p.get('sortBy'), 'id')
  })
})

describe('fetchCanadaFires', () => {
  test('one page when everything fits', async () => {
    const urls = []
    const fires = await fetchCanadaFires(BASE, async (url) => { urls.push(url); return okJson(cwfis) }, NOW)
    assert.equal(urls.length, 1)
    assert.equal(fires.length, 9)  // 90 current records, 9 updated within 30 days
  })

  test('pages until numberMatched is reached', async () => {
    const all = cwfis.features
    const starts = []
    const stub = async (url) => {
      const p = new URL(url).searchParams
      const start = Number(p.get('startIndex'))
      const count = Number(p.get('count'))
      starts.push(start)
      return okJson({ ...cwfis, numberMatched: all.length, features: all.slice(start, start + count) })
    }
    const fires = await fetchCanadaFires(BASE, stub, NOW, { pageSize: 40 })
    assert.deepEqual(starts, [0, 40, 80])
    assert.equal(fires.length, 9)  // 90 current records, 9 updated within 30 days
  })

  test('stops on an empty page even if numberMatched says more', async () => {
    let calls = 0
    const stub = async () => { calls++; return okJson({ ...cwfis, numberMatched: 1000, features: calls === 1 ? cwfis.features : [] }) }
    const fires = await fetchCanadaFires(BASE, stub, NOW, { pageSize: 90 })
    assert.equal(calls, 2)
    assert.equal(fires.length, 9)  // 90 current records, 9 updated within 30 days
  })

  test('HTTP error throws, naming the source', async () => {
    await assert.rejects(fetchCanadaFires(BASE, async () => ({ ok: false, status: 503 }), NOW), /CWFIS.*503/)
  })
})

describe('fetchWildfires with both sources', () => {
  const cfg = {
    perimetersUrl: 'https://nifc.example/perimeters',
    incidentsUrl: 'https://nifc.example/incidents',
    canadaUrl: BASE,
  }
  const route = ({ nifcOk = true, canadaOk = true } = {}) => async (url) => {
    if (url.startsWith(BASE)) return canadaOk ? okJson(cwfis) : ({ ok: false, status: 403 })
    if (!nifcOk) return { ok: false, status: 500 }
    return okJson(url.startsWith(cfg.incidentsUrl) ? nifcIncidents : { type: 'FeatureCollection', features: [] })
  }
  const quiet = { warn: () => {} }

  test('both work: US and Canadian fires together, each with its source', async () => {
    const fires = await fetchWildfires({ cfg, fetchImpl: route(), now: NOW, log: quiet })
    assert.equal(fires.filter((f) => f.source === 'CWFIS').length, 9)  // 90 current records, 9 updated within 30 days
    assert.ok(fires.filter((f) => f.source === 'NIFC').length > 0)
  })

  test('Canada blocked (CSP, down): US fires still come back', async () => {
    const fires = await fetchWildfires({ cfg, fetchImpl: route({ canadaOk: false }), now: NOW, log: quiet })
    assert.ok(fires.length > 0)
    assert.ok(fires.every((f) => f.source === 'NIFC'))
  })

  test('NIFC down: Canadian fires still come back', async () => {
    const fires = await fetchWildfires({ cfg, fetchImpl: route({ nifcOk: false }), now: NOW, log: quiet })
    assert.equal(fires.length, 9)  // 90 current records, 9 updated within 30 days
    assert.ok(fires.every((f) => f.source === 'CWFIS'))
  })

  test('a failing source is logged, not silent', async () => {
    const warned = []
    await fetchWildfires({ cfg, fetchImpl: route({ canadaOk: false }), now: NOW, log: { warn: (m) => warned.push(m) } })
    assert.equal(warned.length, 1)
    assert.match(warned[0], /CWFIS/)
  })

  test('both failing rejects (the app keeps the fires it already has)', async () => {
    await assert.rejects(fetchWildfires({ cfg, fetchImpl: route({ nifcOk: false, canadaOk: false }), now: NOW, log: quiet }))
  })

  test('no canadaUrl: Canada is off and never requested', async () => {
    const urls = []
    const fetchImpl = async (url) => { urls.push(url); return route()(url) }
    await fetchWildfires({ cfg: { ...cfg, canadaUrl: '' }, fetchImpl, now: NOW, log: quiet })
    assert.equal(urls.some((u) => u.startsWith(BASE)), false)
  })

  test('only canadaUrl: NIFC is off and never requested', async () => {
    const urls = []
    const fetchImpl = async (url) => { urls.push(url); return route()(url) }
    const fires = await fetchWildfires({ cfg: { canadaUrl: BASE }, fetchImpl, now: NOW, log: quiet })
    assert.equal(fires.length, 9)  // 90 current records, 9 updated within 30 days
    assert.ok(urls.every((u) => u.startsWith(BASE)))
  })

  test('no wildfires settings at all: []', async () => {
    assert.deepEqual(await fetchWildfires({ cfg: undefined, fetchImpl: route(), now: NOW, log: quiet }), [])
  })
})
