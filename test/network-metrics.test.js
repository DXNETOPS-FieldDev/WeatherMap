// Tests for src/api/network-metrics.js — run with `npm test`.
//
// Per-device Availability and Bandwidth for the popup's Metrics tab. Bandwidth
// comes from portmfs scoped to the dashboard's group (newest samples of the 15
// minutes before the end of the range); availability from availabilitymfs, with
// reachabilitymfs as a labelled fallback, fetched by device-id batches (89 ids
// in one URL made Performance Center answer 400, so batches stay small).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fetchNetworkMetrics } from '../src/api/network-metrics.js'

const END = 1_800_000_000
const RANGE = { startTime: END - 3600, endTime: END }

function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return handler(String(url))
  }
  return calls
}
const json = (value) => new Response(JSON.stringify({ value }), { status: 200 })
const port = (id, device, t, inBps, outBps, speed = 1e9) => ({
  ID: id, DeviceItemID: device, Timestamp: t, im_BitsPerSecondIn: inBps, im_BitsPerSecondOut: outBps, im_SpeedIn: speed, im_SpeedOut: speed,
})
const familyOf = (url) => (url.includes('/portmfs') ? 'bandwidth' : url.includes('/availabilitymfs') ? 'availability' : url.includes('/reachabilitymfs') ? 'reachability' : 'other')
const idsIn = (url) => {
  const f = decodeURIComponent(new URL(url, 'https://pc').searchParams.get('$filter') || '')
  const m = f.match(/DeviceItemID in \(([^)]*)\)/)
  return m ? m[1].split(',').map(Number) : []
}

describe('fetchNetworkMetrics', () => {
  test('bandwidth: one request scoped to the group, newest 15 minutes before the end of the range, in seconds', async () => {
    const calls = stubFetch((u) => json([]))
    await fetchNetworkMetrics({ groupId: 14333, deviceIds: [1], ...RANGE })
    const bw = calls.filter((u) => familyOf(u) === 'bandwidth')
    assert.equal(bw.length, 1)
    const q = new URL(bw[0], 'https://pc').searchParams
    assert.equal(q.get('$filter'), 'groups/any(L1:L1/ID eq 14333)')
    assert.equal(q.get('starttime'), String(END - 900))
    assert.equal(q.get('endtime'), String(END))
  })

  test('bandwidth asks for each interface\'s name in the same request', async () => {
    const calls = stubFetch(() => json([]))
    await fetchNetworkMetrics({ groupId: 1, deviceIds: [1], ...RANGE })
    const q = new URL(calls.find((u) => familyOf(u) === 'bandwidth'), 'https://pc').searchParams
    assert.equal(q.get('$expand'), 'interface($select=Name)')
  })

  test('the busiest interface reaches the result, named', async () => {
    stubFetch((u) => (familyOf(u) === 'bandwidth'
      ? json([{ ...port(10, 1, END - 300, 1e8, 3e8), interface: { Name: 'Et0/1' } }, port(11, 1, END - 300, 1e7, 1e7)])
      : json([])))
    const { byDevice } = await fetchNetworkMetrics({ groupId: 1, deviceIds: [1], ...RANGE })
    assert.deepEqual(byDevice.get(1).bandwidth.busiest, { interfaceId: 10, name: 'Et0/1', utilInPct: 10, utilOutPct: 30 })
  })

  test('an end time in milliseconds or ISO text still becomes seconds', async () => {
    for (const endTime of [END * 1000, new Date(END * 1000).toISOString()]) {
      const calls = stubFetch(() => json([]))
      await fetchNetworkMetrics({ groupId: 1, deviceIds: [1], startTime: 0, endTime })
      const q = new URL(calls.find((u) => familyOf(u) === 'bandwidth'), 'https://pc').searchParams
      assert.equal(q.get('endtime'), String(END))
    }
  })

  test('interface rows are summed per device, from the newest sample of each interface', async () => {
    stubFetch((u) => (familyOf(u) === 'bandwidth'
      ? json([port(10, 1, END - 600, 9e8, 9e8), port(10, 1, END - 300, 1e8, 2e8), port(11, 1, END - 300, 3e8, 4e8), port(20, 2, END - 300, 5e8, 5e8)])
      : json([])))
    const { byDevice } = await fetchNetworkMetrics({ groupId: 1, deviceIds: [1, 2], ...RANGE })
    const d1 = byDevice.get(1).bandwidth
    assert.equal(d1.interfaces, 2)
    assert.equal(d1.inBps, 4e8)
    assert.equal(d1.outBps, 6e8)
    assert.equal(d1.utilInPct, 20)
    assert.equal(byDevice.get(2).bandwidth.utilInPct, 50)
  })

  test('availability is the mean of the range for each device', async () => {
    stubFetch((u) => (familyOf(u) === 'availability'
      ? json([{ DeviceItemID: 1, im_Availability: 100 }, { DeviceItemID: 1, im_Availability: 98 }, { DeviceItemID: 2, im_Availability: 50 }])
      : json([])))
    const { byDevice } = await fetchNetworkMetrics({ groupId: 1, deviceIds: [1, 2], ...RANGE })
    assert.deepEqual(byDevice.get(1).availability, { value: 99, kind: 'availability' })
    assert.deepEqual(byDevice.get(2).availability, { value: 50, kind: 'availability' })
  })

  test('availability covers the dashboard range, but never more than the last 24 hours', async () => {
    const win = async (startTime) => {
      const calls = stubFetch(() => json([]))
      await fetchNetworkMetrics({ groupId: 1, deviceIds: [1], startTime, endTime: END })
      const q = new URL(calls.find((u) => familyOf(u) === 'availability'), 'https://pc').searchParams
      return [Number(q.get('starttime')), Number(q.get('endtime'))]
    }
    assert.deepEqual(await win(END - 3600), [END - 3600, END])
    assert.deepEqual(await win(END - 7 * 86400), [END - 86400, END])
    assert.deepEqual(await win(undefined), [END - 3600, END])
  })

  test('a device with no availability falls back to reachability, labelled', async () => {
    stubFetch((u) => (familyOf(u) === 'reachability' ? json([{ DeviceItemID: 3, im_Reachability: 87 }]) : json([])))
    const { byDevice } = await fetchNetworkMetrics({ groupId: 1, deviceIds: [3], ...RANGE })
    assert.deepEqual(byDevice.get(3).availability, { value: 87, kind: 'reachability' })
  })

  test('a device that reports neither has no value, and no invented one', async () => {
    stubFetch(() => json([]))
    const { byDevice } = await fetchNetworkMetrics({ groupId: 1, deviceIds: [4], ...RANGE })
    assert.deepEqual(byDevice.get(4).availability, { value: null, kind: null })
    assert.equal(byDevice.get(4).bandwidth, null)
  })

  test('device ids are sent in small batches, so no URL is long (89 ids once failed)', async () => {
    const ids = Array.from({ length: 89 }, (_, i) => 1000 + i)
    const calls = stubFetch(() => json([]))
    await fetchNetworkMetrics({ groupId: 1, deviceIds: ids, ...RANGE })
    const av = calls.filter((u) => familyOf(u) === 'availability')
    const re = calls.filter((u) => familyOf(u) === 'reachability')
    assert.equal(av.length, 3)
    assert.equal(re.length, 3)
    for (const u of calls) assert.ok(u.length < 2500, `URL is ${u.length} chars`)
    assert.deepEqual(av.flatMap(idsIn).sort((a, b) => a - b), ids)
  })

  test('one failing family is reported and does not take the others down', async () => {
    stubFetch((u) => (familyOf(u) === 'bandwidth' ? new Response('boom', { status: 500 }) : json([{ DeviceItemID: 1, im_Availability: 100 }])))
    const { byDevice, errors } = await fetchNetworkMetrics({ groupId: 1, deviceIds: [1], ...RANGE })
    assert.deepEqual(byDevice.get(1).availability, { value: 100, kind: 'availability' })
    assert.equal(byDevice.get(1).bandwidth, null)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /bandwidth.*HTTP 500/i)
  })

  test('hitting the row cap is flagged: the newest samples may be missing', async () => {
    const many = Array.from({ length: 20000 }, (_, i) => port(i + 1, 1, END - 300, 1, 1))
    stubFetch((u) => (familyOf(u) === 'bandwidth' ? json(many) : json([])))
    const { truncated } = await fetchNetworkMetrics({ groupId: 1, deviceIds: [1], ...RANGE })
    assert.equal(truncated, true)
  })

  test('below the cap is not flagged', async () => {
    stubFetch(() => json([port(1, 1, END - 300, 1, 1)]))
    const { truncated } = await fetchNetworkMetrics({ groupId: 1, deviceIds: [1], ...RANGE })
    assert.equal(truncated, false)
  })

  test('duplicate and junk device ids are asked about once, or not at all', async () => {
    const calls = stubFetch(() => json([]))
    const { byDevice } = await fetchNetworkMetrics({ groupId: 1, deviceIds: [5, '5', 5, 6, null, 'x', 1.5, undefined], ...RANGE })
    const asked = calls.filter((u) => familyOf(u) === 'availability').flatMap(idsIn)
    assert.deepEqual(asked.sort((a, b) => a - b), [5, 6])
    assert.deepEqual([...byDevice.keys()].sort((a, b) => a - b), [5, 6])
  })

  test('nothing to ask about: no requests', async () => {
    const calls = stubFetch(() => json([]))
    const none = await fetchNetworkMetrics({ groupId: 1, deviceIds: [], ...RANGE })
    assert.equal(calls.length, 0)
    assert.equal(none.byDevice.size, 0)
  })

  test('debug mode has no live metrics and makes no request', async () => {
    const calls = stubFetch(() => json([]))
    const r = await fetchNetworkMetrics({ groupId: 1, deviceIds: [1], debug: true, ...RANGE })
    assert.equal(calls.length, 0)
    assert.equal(r.byDevice.size, 0)
  })
})

// WAN circuits (metrics.wanGroup): the members of one PC interface group, on the map's devices,
// with their newest bandwidth samples. Measured on dev-netops 2026-11-08: an interface-group
// filter works on both `interfaces` and `portmfs` (a bogus group id returns 0 rows), while
// `device/groups/any(...)` is SILENTLY IGNORED — so the map's devices are matched by id batches.
describe('fetchNetworkMetrics: WAN circuits', () => {
  const W = 590260
  const filterOf = (u) => decodeURIComponent(new URL(u, 'https://pc').searchParams.get('$filter') || '')
  const isWanInventory = (u) => u.includes('/interfaces?') && filterOf(u).includes(`groups/any(L1:L1/ID eq ${W})`)
  const isWanSamples = (u) => u.includes('/portmfs?') && filterOf(u).includes(`groups/any(L1:L1/ID eq ${W})`)
  const isGroupLookup = (u) => u.includes('/groups?')
  const ifRow = (id, device, name) => ({ ID: id, DeviceItemID: device, Name: name, Alias: null, SpeedIn: 50e6, SpeedOut: 50e6 })

  test('not configured: no WAN requests and no `wan` on the devices', async () => {
    const calls = stubFetch(() => json([]))
    const { byDevice } = await fetchNetworkMetrics({ groupId: 1, deviceIds: [7], ...RANGE })
    assert.equal(calls.filter((u) => u.includes('/interfaces?') || isGroupLookup(u)).length, 0)
    assert.equal('wan' in byDevice.get(7), false)
  })

  test('a group id: inventory and samples by 40-device batches, group AND device ids, last 15 minutes', async () => {
    const calls = stubFetch(() => json([]))
    const ids = Array.from({ length: 45 }, (_, i) => i + 1)
    await fetchNetworkMetrics({ groupId: 1, deviceIds: ids, ...RANGE, wanGroup: W })
    const inv = calls.filter(isWanInventory), smp = calls.filter(isWanSamples)
    assert.deepEqual(inv.map((u) => idsIn(u).length), [40, 5])
    assert.deepEqual(smp.map((u) => idsIn(u).length), [40, 5])
    assert.equal(filterOf(inv[0]), `groups/any(L1:L1/ID eq ${W}) and DeviceItemID in (${ids.slice(0, 40).join(',')})`)
    const q = new URL(smp[0], 'https://pc').searchParams
    assert.equal(q.get('starttime'), String(END - 900))
    assert.equal(q.get('endtime'), String(END))
    assert.equal(calls.filter(isGroupLookup).length, 0)
  })

  test('each device gets its circuits, worst first; a device without any gets [] (none, not unknown)', async () => {
    stubFetch((u) => (isWanInventory(u) ? json([ifRow(10, 7, 'ge0/0'), ifRow(11, 7, 'ge0/1')])
      : isWanSamples(u) ? json([port(10, 7, END - 300, 5e6, 1e6, 50e6), port(11, 7, END - 300, 40e6, 1e6, 50e6)])
      : json([])))
    const { byDevice } = await fetchNetworkMetrics({ groupId: 1, deviceIds: [7, 8], ...RANGE, wanGroup: W })
    assert.deepEqual(byDevice.get(7).wan.map((c) => [c.name, c.inPct]), [['ge0/1', 80], ['ge0/0', 10]])
    assert.deepEqual(byDevice.get(8).wan, [])
  })

  test('a group name is looked up by exact name (quotes escaped), then used by id', async () => {
    const calls = stubFetch((u) => (isGroupLookup(u) ? json([{ ID: W, Name: "Omar's WAN" }]) : json([])))
    await fetchNetworkMetrics({ groupId: 1, deviceIds: [7], ...RANGE, wanGroup: "Omar's WAN" })
    assert.equal(filterOf(calls.find(isGroupLookup)), "Name eq 'Omar''s WAN'")
    assert.equal(calls.filter(isWanInventory).length, 1)
  })

  test('a name that matches no group, or several, is an error; circuits are unknown (null) and nothing else is asked', async () => {
    for (const found of [[], [{ ID: 1, Name: 'X' }, { ID: 2, Name: 'X' }]]) {
      const calls = stubFetch((u) => (isGroupLookup(u) ? json(found) : json([])))
      const r = await fetchNetworkMetrics({ groupId: 1, deviceIds: [7], ...RANGE, wanGroup: 'X' })
      assert.equal(r.byDevice.get(7).wan, null)
      assert.match(r.errors.join(' '), /WAN group "X"/)
      assert.equal(calls.filter((u) => u.includes('/interfaces?')).length, 0)
    }
  })

  test('a setting that is neither a positive id nor a name is an error, with no request built from it', async () => {
    for (const bad of [0, -3, 1.5, '', '   ', {}, true]) {
      const calls = stubFetch(() => json([]))
      const r = await fetchNetworkMetrics({ groupId: 1, deviceIds: [7], ...RANGE, wanGroup: bad })
      assert.equal(r.byDevice.get(7).wan, null, JSON.stringify(bad))
      assert.equal(calls.filter((u) => u.includes('/interfaces?') || isGroupLookup(u)).length, 0, JSON.stringify(bad))
    }
  })

  test('a failing batch leaves only its own devices unknown, and is reported', async () => {
    stubFetch((u) => (isWanInventory(u) && idsIn(u).includes(1) ? new Response('x', { status: 500 }) : json([])))
    const ids = Array.from({ length: 45 }, (_, i) => i + 1)
    const r = await fetchNetworkMetrics({ groupId: 1, deviceIds: ids, ...RANGE, wanGroup: W })
    assert.equal(r.byDevice.get(1).wan, null)
    assert.deepEqual(r.byDevice.get(45).wan, [])
    assert.match(r.errors.join(' '), /WAN circuits/)
  })

  test('the WAN lookup does not disturb availability or the device-wide bandwidth', async () => {
    const calls = stubFetch(() => json([]))
    await fetchNetworkMetrics({ groupId: 1, deviceIds: [7], ...RANGE, wanGroup: W })
    assert.equal(calls.filter((u) => familyOf(u) === 'bandwidth' && !isWanSamples(u)).length, 1)
    assert.ok(calls.some((u) => familyOf(u) === 'availability'))
  })
})
