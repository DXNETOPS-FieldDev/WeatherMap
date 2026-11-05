// Tests for src/api/pc-alarms.js — run with `npm test`.
//
// The "Thresholds" variant reads the map's devices' active threshold alarms from
// Performance Center OData `activealarms`, in device-id batches (89 ids in one
// URL made Performance Center answer 400 elsewhere, so batches stay at 40). An
// interface alarm's own ItemID is the interface, so each batch also matches
// interface/DeviceItemID, with the interface expanded for its name and device.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fetchThresholdAlarms } from '../src/api/pc-alarms.js'

function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return handler(String(url))
  }
  return calls
}
const json = (value) => new Response(JSON.stringify({ value }), { status: 200 })
const params = (url) => new URL(url, 'https://pc').searchParams
const idsIn = (url) => {
  const m = (params(url).get('$filter') || '').match(/ItemID in \(([^)]*)\)/)
  return m ? m[1].split(',').map(Number) : []
}
const alarmRow = (over = {}) => ({
  ID: 1, ItemID: 7, Severity: 0, AlarmType: 'Threshold', ProfileName: 'BW Utilization', StartTime: 100, ClearTime: 0,
  Description: 'A Threshold Violation event has been raised. (Profile Name: BW Utilization, Rule Name: BW Utilization In > 30%)',
  MetricValuesMax: '40.5', interface: null, ...over,
})

describe('fetchThresholdAlarms', () => {
  test('one request per 40 devices, each asking for threshold alarms on the devices or their interfaces', async () => {
    const calls = stubFetch(() => json([]))
    const ids = Array.from({ length: 85 }, (_, i) => i + 1)
    await fetchThresholdAlarms(ids)
    assert.equal(calls.length, 3)
    assert.deepEqual(calls.map((u) => idsIn(u).length), [40, 40, 5])
    assert.deepEqual(calls.flatMap(idsIn), ids)
    const q = params(calls[0])
    assert.ok(calls[0].startsWith('/pc/odata4/api/activealarms?'))
    const list = idsIn(calls[0]).join(',')
    assert.equal(q.get('$filter'), `AlarmType eq 'Threshold' and (ItemID in (${list}) or interface/DeviceItemID in (${list}))`)
    assert.equal(q.get('$expand'), 'interface($select=Name,DeviceItemID,GlobalID)')
    assert.equal(q.get('$format'), 'application/json')
    for (const col of ['ID', 'ItemID', 'Severity', 'AlarmType', 'ProfileName', 'StartTime', 'ClearTime', 'Description', 'MetricValuesMax']) {
      assert.ok(q.get('$select').split(',').includes(col), col)
    }
  })

  test('ids are de-duplicated and junk ids dropped (Number(null) would be device 0)', async () => {
    const calls = stubFetch(() => json([]))
    await fetchThresholdAlarms([5, 5, '6', null, '', 'x', 0, -1, 7.5])
    assert.deepEqual(calls.flatMap(idsIn), [5, 6])
  })

  test('no devices, or debug mode: no request, an empty result', async () => {
    const calls = stubFetch(() => { throw new Error('should not fetch') })
    for (const r of [await fetchThresholdAlarms([]), await fetchThresholdAlarms(undefined), await fetchThresholdAlarms([1], { debug: true })]) {
      assert.equal(r.byDevice.size, 0)
      assert.deepEqual(r.errors, [])
      assert.equal(r.truncated, false)
    }
    assert.equal(calls.length, 0)
  })

  test('alarms are grouped by device, interface alarms under their device, worst first', async () => {
    stubFetch(() => json([
      alarmRow({ ID: 1, Severity: 2 }),
      alarmRow({ ID: 2, ItemID: 900, interface: { Name: 'ge0/0', DeviceItemID: 7 }, Severity: 0 }),
      alarmRow({ ID: 3, ItemID: 8, Severity: 1 }),
    ]))
    const { byDevice } = await fetchThresholdAlarms([7, 8])
    assert.deepEqual(byDevice.get(7).map((a) => a.id), [2, 1])
    assert.equal(byDevice.get(7)[0].interfaceName, 'ge0/0')
    assert.deepEqual(byDevice.get(8).map((a) => a.severity), ['Major'])
  })

  test('a device that answered with no alarms has an empty list, so "none" differs from "not loaded"', async () => {
    stubFetch(() => json([]))
    const { byDevice } = await fetchThresholdAlarms([7])
    assert.deepEqual(byDevice.get(7), [])
  })

  test('a failing batch is reported and leaves only its own devices without an entry', async () => {
    stubFetch((u) => (idsIn(u).includes(1) ? new Response('boom', { status: 400 }) : json([alarmRow({ ItemID: 45 })])))
    const ids = Array.from({ length: 45 }, (_, i) => i + 1)
    const { byDevice, errors } = await fetchThresholdAlarms(ids)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /HTTP 400/)
    assert.equal(byDevice.has(1), false)
    assert.equal(byDevice.has(40), false)
    assert.equal(byDevice.get(45).length, 1)
    assert.deepEqual(byDevice.get(41), [])
  })

  test('a batch that hits the row cap is flagged as truncated', async () => {
    stubFetch(() => json(Array.from({ length: 5000 }, (_, i) => alarmRow({ ID: i }))))
    assert.equal((await fetchThresholdAlarms([7])).truncated, true)
  })

  test('each batch asks for at most 5000 rows', async () => {
    const calls = stubFetch(() => json([]))
    await fetchThresholdAlarms([7])
    assert.equal(params(calls[0]).get('$top'), '5000')
  })

  test('a batch under the cap is not truncated', async () => {
    stubFetch(() => json([alarmRow()]))
    assert.equal((await fetchThresholdAlarms([7])).truncated, false)
  })
})
