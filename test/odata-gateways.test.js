// Tests for the devices queries in src/api/odata.js — run with `npm test`.
//
// The group's own devices query must stay byte-for-byte what it was (a golden
// string, captured from v1.1.0 before the refactor that shares its builder).
// The gateway query fetches the configured devices by ID / exact name instead
// of by group, WITHOUT the "has coordinates" filter (so a gateway that has no
// coordinates can be reported rather than silently missing) and WITHOUT the
// controller / AppNeta exclusions the group's devices get: a gateway that is
// listed on purpose is shown even if its name looks like an SD-WAN controller.
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadRuntimeConfig } from '../src/lib/config.js'
import { gatewayFilter } from '../src/lib/gateways.js'
import { fetchDevices, fetchGatewayDevices } from '../src/api/odata.js'

const CONFIG = { odata: { topLimit: 500, resolution: 'RATE' }, includeAppNeta: false, includeSdwanControllers: false }
const GROUP_FILTER = '(Latitude ne null) and (groups/any(L1:L1/ID eq 14339))'

// Captured from v1.1.0: fetchDevices({ id: 14339, startTime: 100, endTime: 200 }).
const GOLDEN_GROUP_URL = '/pc/odata4/api/devices?$select=GlobalID,ID,Name,PrimaryIPAddress,Location,Longitude,Latitude&$filter=(Latitude ne null) and (groups/any(L1:L1/ID eq 14339))&$expand=cpuandmemorymfs($apply=groupby((DeviceItemID),aggregate(im_CPUUtilization with average as Value,im_MemoryUtilization with average as Value1,im_DiskPercentUsed with average as Value2)))&starttime=100&endtime=200&resolution=RATE&$format=text/csv&$top=500'

const HEADER = '"GlobalID","ID","Name","PrimaryIPAddress","Location","Longitude","Latitude"'
const csv = (...rows) => [HEADER, ...rows.map((r) => r.map((v) => (typeof v === 'string' ? `"${v}"` : (v ?? ''))).join(','))].join('\n')
const row = (id, name, lng, lat, ip = '10.0.0.1') => [id + 1000, id, name, ip, 'Somewhere', lng, lat]

function stub(body, status = 200) {
  const calls = []
  globalThis.fetch = async (url) => {
    if (url === './runtime-config.json') return new Response(JSON.stringify(CONFIG), { status: 200 })
    calls.push(url)
    return new Response(body, { status })
  }
  return calls
}

describe('group devices query (characterization)', () => {
  beforeEach(async () => { stub(''); await loadRuntimeConfig() })

  test('is byte-for-byte what v1.1.0 sent', async () => {
    const calls = stub(csv())
    await fetchDevices({ id: 14339, startTime: 100, endTime: 200 })
    assert.equal(calls.length, 1)
    assert.equal(calls[0], GOLDEN_GROUP_URL)
  })
})

describe('fetchGatewayDevices', () => {
  beforeEach(async () => { stub(''); await loadRuntimeConfig() })
  const T = { startTime: 100, endTime: 200 }

  test('selects by id and exact name, with the same columns, metrics and time window as the group query', async () => {
    const refs = { ids: [7114], names: ["O'Hare-GW"] }
    const calls = stub(csv())
    await fetchGatewayDevices({ refs, ...T })
    const expected = GOLDEN_GROUP_URL.replace(GROUP_FILTER, encodeURIComponent(gatewayFilter(refs)))
    assert.equal(calls.length, 1)
    assert.equal(calls[0], expected)
  })

  test('there is no coordinates filter and no group in the query', async () => {
    const calls = stub(csv())
    await fetchGatewayDevices({ refs: { ids: [7114], names: [] }, ...T })
    assert.doesNotMatch(calls[0], /Latitude ne null|Latitude%20ne|groups\/any|groups%2Fany/)
  })

  test('awkward characters in a name are encoded, not left to break the URL', async () => {
    const refs = { ids: [], names: ['A&B #1+x', "a'b", '100%'] }
    const calls = stub(csv())
    await fetchGatewayDevices({ refs, ...T })
    const url = calls[0]
    assert.equal(url.split('#').length, 1, 'a raw # would cut the URL short')
    const decoded = new URL(url, 'https://pc').searchParams.get('$filter')
    assert.equal(decoded, gatewayFilter(refs))
  })

  test('nothing configured: no request at all', async () => {
    for (const refs of [undefined, null, {}, { ids: [], names: [] }, { ids: [Number.NaN], names: [''] }]) {
      const calls = stub(csv())
      assert.deepEqual(await fetchGatewayDevices({ refs, ...T }), [])
      assert.equal(calls.length, 0, `refs ${JSON.stringify(refs)}`)
    }
  })

  test('debug mode has no sample gateways and makes no request', async () => {
    const calls = stub(csv(row(1, 'GW', -75, 40)))
    assert.deepEqual(await fetchGatewayDevices({ refs: { ids: [1], names: [] }, debug: true, ...T }), [])
    assert.equal(calls.length, 0)
  })

  test('devices come back normalized', async () => {
    stub(csv(row(7114, 'SIN-GW-01', 103.8, 1.35, '10.9.9.9')))
    const [d] = await fetchGatewayDevices({ refs: { ids: [7114], names: [] }, ...T })
    assert.equal(d.id, 7114)
    assert.equal(d.name, 'SIN-GW-01')
    assert.equal(d.ip, '10.9.9.9')
    assert.equal(d.latitude, 1.35)
    assert.equal(d.longitude, 103.8)
  })

  test('a listed gateway is kept even when its name matches a controller or AppNeta exclusion', async () => {
    const body = csv(
      row(1, 'Controller-01', -75, 40),
      row(2, 'vSmart', -76, 41),
      row(3, 'vManage', -77, 42),
      row(4, 'dev-vk35-Miami-AppNeta', -80, 25),
    )
    stub(body)
    const gateways = await fetchGatewayDevices({ refs: { ids: [1, 2, 3, 4], names: [] }, ...T })
    assert.deepEqual(gateways.map((d) => d.name), ['Controller-01', 'vSmart', 'vManage', 'dev-vk35-Miami-AppNeta'])

    // The contrast that makes this a rule: the group's own query drops all four.
    stub(body)
    assert.deepEqual(await fetchDevices({ id: 14339, ...T }), [])
  })

  test('a device with no coordinates is still returned, so it can be reported', async () => {
    stub(csv(row(5, 'NO-COORDS', null, null)))
    const [d] = await fetchGatewayDevices({ refs: { ids: [5], names: [] }, ...T })
    assert.equal(d.name, 'NO-COORDS')
    assert.ok(!d.latitude && !d.longitude)
  })

  test('the same device on two rows (several metric items) is returned once', async () => {
    stub(csv(row(7, 'GW', -75, 40), row(7, 'GW', -75, 40), row(8, 'OTHER', -70, 41)))
    const out = await fetchGatewayDevices({ refs: { ids: [7, 8], names: [] }, ...T })
    assert.deepEqual(out.map((d) => d.id), [7, 8])
  })

  test('a name that matches several devices returns them all', async () => {
    stub(csv(row(7118, 'FlexVNF-004-Atlanta', -84, 33), row(280273, 'FlexVNF-004-Atlanta', -84, 33), row(280431, 'FlexVNF-004-Atlanta', null, null)))
    const out = await fetchGatewayDevices({ refs: { ids: [], names: ['FlexVNF-004-Atlanta'] }, ...T })
    assert.deepEqual(out.map((d) => d.id), [7118, 280273, 280431])
  })

  test('a failing query throws, naming the status', async () => {
    stub('nope', 500)
    await assert.rejects(fetchGatewayDevices({ refs: { ids: [1], names: [] }, ...T }), /Gateways query failed: HTTP 500/)
  })
})
