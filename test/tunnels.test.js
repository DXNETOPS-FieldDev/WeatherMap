// Unit tests for the SD-WAN tunnel query in src/api/tunnels.js — run with
// `npm test`.
//
// The tunnel query used to name every map device twice in one URL
// ("(SourceDeviceID eq ...) and (DestinationDeviceID eq ...)"). At 88 devices
// that URL was 7,099 characters and Performance Center rejected it with HTTP
// 400, so large groups showed no tunnels. It is now split into several
// requests filtered on source device only, and the destination check is done
// here — the same rule: both ends must be on the map.
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadRuntimeConfig } from '../src/lib/config.js'
import { fetchTunnels, tunnelSourceFilters } from '../src/api/tunnels.js'

const CONFIG = {
  tunnels: { apiPath: '/pc/odata4/api/sdntunnels', lookbackSeconds: 3600, maxRecords: 5000 },
}

// The device ids in the 7,099-character URL from the dev Portal's All Groups
// view (89 ids for the 88 devices on the map).
const DEV_IDS = [
  7115, 7116, 7117, 7118, 10023, 13470, 13472, 13475, 13476, 13973, 13974, 13975, 13976, 13977,
  227139, 230164, 232746, 280273, 309670, 309671, 309672, 309674, 309675, 309676, 309678, 309680,
  309681, 309682, 309683, 309684, 309685, 357150, 357153, 357163, 357165, 357167, 357168, 357169,
  357170, 357171, 357172, 357173, 357174, 357175, 357176, 364518, 400605, 492308, 515569, 515591,
  515613, 515655, 542151, 1078043, 1078087, 1078099, 1078100, 1078101, 1078102, 1078103, 1078104,
  1078105, 1078106, 1078107, 1078108, 1078200, 1078201, 1078202, 1078203, 1078204, 1078205,
  1078206, 1078207, 1078208, 1078209, 1078210, 1078211, 1078212, 1078213, 1078214, 1078215,
  1078404, 1090468, 1138089, 1138090, 1138091, 1138092, 1138094, 1138095,
]

const MAX_URL = 2500

function row(id, src, dst) {
  return { ID: id, Name: `t${id}`, SourceDeviceID: src, DestinationDeviceID: dst, sdntunnelmfs: [] }
}

function sourcesIn(url) {
  const filter = decodeURIComponent(new URL(url, 'https://pc').searchParams.get('$filter'))
  return [...filter.matchAll(/SourceDeviceID eq (\d+)/g)].map((m) => Number(m[1]))
}

// Answers ./runtime-config.json, then hands each tunnel request to `handler`.
function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url) => {
    if (url === './runtime-config.json') {
      return new Response(JSON.stringify(CONFIG), { status: 200 })
    }
    calls.push(url)
    return handler(url)
  }
  return calls
}

const json = (value) => new Response(JSON.stringify({ value }), { status: 200 })

describe('tunnelSourceFilters', () => {
  test('no devices, no filters', () => {
    assert.deepEqual(tunnelSourceFilters([], 40), [])
  })

  test('every device appears in exactly one filter', () => {
    const filters = tunnelSourceFilters(DEV_IDS, 40)
    assert.equal(filters.length, 3)
    const seen = filters.flatMap((f) => [...f.matchAll(/SourceDeviceID eq (\d+)/g)].map((m) => Number(m[1])))
    assert.deepEqual([...seen].sort((a, b) => a - b), [...DEV_IDS].sort((a, b) => a - b))
  })

  test('filters name source devices only', () => {
    for (const f of tunnelSourceFilters(DEV_IDS, 40)) {
      assert.doesNotMatch(f, /DestinationDeviceID/)
    }
  })

  test('chunk size is respected at the boundary', () => {
    assert.equal(tunnelSourceFilters(DEV_IDS.slice(0, 40), 40).length, 1)
    assert.equal(tunnelSourceFilters(DEV_IDS.slice(0, 41), 40).length, 2)
  })
})

describe('fetchTunnels', () => {
  beforeEach(async () => {
    stubFetch(() => json([]))
    await loadRuntimeConfig()
  })

  test('the dev Portal\'s 89 ids: several requests, each URL well under the limit', async () => {
    const calls = stubFetch(() => json([]))
    await fetchTunnels(DEV_IDS)
    assert.ok(calls.length > 1, `expected the query split, got ${calls.length} request(s)`)
    for (const url of calls) assert.ok(url.length < MAX_URL, `URL is ${url.length} chars`)
    const asked = calls.flatMap(sourcesIn).sort((a, b) => a - b)
    assert.deepEqual(asked, [...DEV_IDS].sort((a, b) => a - b))
  })

  test('keeps only tunnels whose destination is also on the map', async () => {
    stubFetch((url) => {
      const srcs = sourcesIn(url)
      const rows = []
      if (srcs.includes(7115)) rows.push(row(1, 7115, 1138095), row(2, 7115, 999999))
      if (srcs.includes(1138095)) rows.push(row(3, 1138095, 7115))
      return json(rows)
    })
    const tunnels = await fetchTunnels(DEV_IDS)
    assert.deepEqual(tunnels.map((t) => t.id).sort(), [1, 3])
  })

  test('a tunnel returned by two requests appears once', async () => {
    stubFetch(() => json([row(7, 7115, 7116)]))
    const tunnels = await fetchTunnels(DEV_IDS)
    assert.equal(tunnels.length, 1)
  })

  test('a failing request fails the whole fetch', async () => {
    let n = 0
    stubFetch(() => (++n === 2 ? new Response('nope', { status: 500 }) : json([])))
    await assert.rejects(fetchTunnels(DEV_IDS), /HTTP 500/)
  })

  test('small groups still make a single request', async () => {
    const calls = stubFetch(() => json([row(5, 7115, 7116)]))
    const tunnels = await fetchTunnels([7115, 7116])
    assert.equal(calls.length, 1)
    assert.equal(tunnels.length, 1)
  })
})
