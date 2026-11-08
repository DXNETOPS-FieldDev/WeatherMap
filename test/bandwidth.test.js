// Unit tests for src/lib/bandwidth.js — run with `npm test`.
//
// A device's bandwidth on the map is the SUM over all its interfaces: total
// throughput in and out, and an aggregate utilization. The utilization is
// capacity-weighted (sum of traffic / sum of interface speeds), never a sum or
// plain average of per-interface percentages: ten interfaces at 50% would
// "sum" to 500%, and a busy 1 Gbps port next to an idle 10 Gbps one is not
// "50% utilized". Rules carried over from BandwidthMap's interface code:
// newest 5-minute sample per interface; im_BitsPerSecond* are already bits per
// second; a speed below 100,000 is megabits (x 1,000,000).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizePortSample, aggregateDeviceBandwidth, pickAvailability, wanCircuitsByDevice } from '../src/lib/bandwidth.js'

const G = 1e9
const sample = (iface, t, inBps, outBps, speedIn = G, speedOut = speedIn, device = 1) => ({
  deviceId: device, interfaceId: iface, t, inBps, outBps, speedInBps: speedIn, speedOutBps: speedOut,
})

describe('normalizePortSample', () => {
  const row = {
    ID: 501, DeviceItemID: 7, Timestamp: 1000,
    im_BitsPerSecondIn: 2_000_000, im_BitsPerSecondOut: 3_000_000,
    im_SpeedIn: 1_000_000_000, im_SpeedOut: 1_000_000_000,
  }

  test('maps the PC columns', () => {
    assert.deepEqual(normalizePortSample(row), {
      deviceId: 7, interfaceId: 501, interfaceName: null, t: 1000,
      inBps: 2_000_000, outBps: 3_000_000, speedInBps: 1e9, speedOutBps: 1e9,
    })
  })

  test('the interface name comes from the expanded interface; blank or absent is null', () => {
    assert.equal(normalizePortSample({ ...row, interface: { Name: 'Et0/1' } }).interfaceName, 'Et0/1')
    assert.equal(normalizePortSample({ ...row, interface: { Name: '' } }).interfaceName, null)
    assert.equal(normalizePortSample({ ...row, interface: null }).interfaceName, null)
  })

  test('numeric strings (CSV) become numbers', () => {
    const s = normalizePortSample({ ID: '501', DeviceItemID: '7', Timestamp: '1000', im_BitsPerSecondIn: '5', im_BitsPerSecondOut: '6', im_SpeedIn: '1000000000' })
    assert.equal(s.deviceId, 7)
    assert.equal(s.interfaceId, 501)
    assert.equal(s.inBps, 5)
    assert.equal(s.speedInBps, 1e9)
  })

  test('a speed under 100,000 is megabits and is scaled; 100,000 and over is bits per second', () => {
    assert.equal(normalizePortSample({ ...row, im_SpeedIn: 1000, im_SpeedOut: 1000 }).speedInBps, 1e9)
    assert.equal(normalizePortSample({ ...row, im_SpeedIn: 99_999, im_SpeedOut: 99_999 }).speedInBps, 99_999e6)
    assert.equal(normalizePortSample({ ...row, im_SpeedIn: 100_000, im_SpeedOut: 100_000 }).speedInBps, 100_000)
  })

  test('speed falls back: out to in, in to the historical speed', () => {
    const noOut = normalizePortSample({ ...row, im_SpeedOut: null })
    assert.equal(noOut.speedOutBps, 1e9)
    const hist = normalizePortSample({ ...row, im_SpeedIn: null, im_SpeedOut: null, im_HistoricalInterfaceSpeed: 100 })
    assert.equal(hist.speedInBps, 100e6)
    assert.equal(hist.speedOutBps, 100e6)
  })

  test('no speed at all is 0 (unrated), not NaN', () => {
    const s = normalizePortSample({ ...row, im_SpeedIn: null, im_SpeedOut: null })
    assert.equal(s.speedInBps, 0)
    assert.equal(s.speedOutBps, 0)
  })

  test('a missing traffic value stays null; it is not 0', () => {
    const s = normalizePortSample({ ...row, im_BitsPerSecondIn: null, im_BitsPerSecondOut: '' })
    assert.equal(s.inBps, null)
    assert.equal(s.outBps, null)
  })

  test('a real zero stays 0', () => {
    assert.equal(normalizePortSample({ ...row, im_BitsPerSecondIn: 0 }).inBps, 0)
  })

  test('a row without a device or interface id is not usable', () => {
    assert.equal(normalizePortSample({ ...row, DeviceItemID: null }), null)
    assert.equal(normalizePortSample({ ...row, ID: undefined }), null)
    assert.equal(normalizePortSample(null), null)
    assert.equal(normalizePortSample('x'), null)
  })
})

describe('aggregateDeviceBandwidth', () => {
  test('nothing in, nothing out', () => {
    assert.equal(aggregateDeviceBandwidth([]).size, 0)
    assert.equal(aggregateDeviceBandwidth(null).size, 0)
    assert.equal(aggregateDeviceBandwidth(undefined).size, 0)
  })

  test('one interface', () => {
    const d = aggregateDeviceBandwidth([sample(10, 1, 200e6, 100e6)]).get(1)
    assert.equal(d.interfaces, 1)
    assert.equal(d.inBps, 200e6)
    assert.equal(d.outBps, 100e6)
    assert.equal(d.utilInPct, 20)
    assert.equal(d.utilOutPct, 10)
  })

  test('throughput is the sum over interfaces', () => {
    const d = aggregateDeviceBandwidth([sample(10, 1, 100e6, 10e6), sample(11, 1, 300e6, 20e6), sample(12, 1, 600e6, 30e6)]).get(1)
    assert.equal(d.interfaces, 3)
    assert.equal(d.inBps, 1000e6)
    assert.equal(d.outBps, 60e6)
  })

  test('utilization is capacity-weighted, not an average or sum of percentages', () => {
    // 1 Gbps port at 100% + 10 Gbps port at 0%: 1G / 11G = 9.09%, not 50%.
    const d = aggregateDeviceBandwidth([sample(10, 1, 1 * G, 0, 1 * G), sample(11, 1, 0, 0, 10 * G)]).get(1)
    assert.ok(Math.abs(d.utilInPct - (100 / 11)) < 1e-9, `got ${d.utilInPct}`)
  })

  test('ten interfaces at 50% read 50%, never 500%', () => {
    const many = Array.from({ length: 10 }, (_, i) => sample(100 + i, 1, 0.5 * G, 0.5 * G, G))
    const d = aggregateDeviceBandwidth(many).get(1)
    assert.equal(d.utilInPct, 50)
    assert.equal(d.utilOutPct, 50)
  })

  test('only the newest sample of each interface counts', () => {
    const d = aggregateDeviceBandwidth([
      sample(10, 100, 900e6, 900e6),
      sample(10, 400, 100e6, 100e6),
      sample(10, 250, 500e6, 500e6),
    ]).get(1)
    assert.equal(d.inBps, 100e6)
    assert.equal(d.interfaces, 1)
  })

  test('samples may arrive in any order', () => {
    const a = aggregateDeviceBandwidth([sample(10, 100, 1, 1), sample(10, 400, 2, 2)]).get(1)
    const b = aggregateDeviceBandwidth([sample(10, 400, 2, 2), sample(10, 100, 1, 1)]).get(1)
    assert.equal(a.inBps, 2)
    assert.equal(b.inBps, 2)
  })

  test('an interface with no speed adds traffic but not capacity: no utilization above 100% from it', () => {
    const d = aggregateDeviceBandwidth([sample(10, 1, 500e6, 0, G), sample(11, 1, 400e6, 0, 0)]).get(1)
    assert.equal(d.inBps, 900e6, 'its traffic is in the total')
    assert.equal(d.utilInPct, 50, 'but the percentage uses rated interfaces only')
  })

  test('an interface whose traffic is missing is left out of both sides of the percentage', () => {
    const d = aggregateDeviceBandwidth([sample(10, 1, 500e6, 0, G), sample(11, 1, null, null, G)]).get(1)
    assert.equal(d.inBps, 500e6)
    assert.equal(d.utilInPct, 50, '1 Gbps of capacity measured, not 2')
  })

  test('no measured traffic at all is null, not 0', () => {
    const d = aggregateDeviceBandwidth([sample(10, 1, null, null, G)]).get(1)
    assert.equal(d.inBps, null)
    assert.equal(d.outBps, null)
    assert.equal(d.utilInPct, null)
    assert.equal(d.interfaces, 1)
  })

  test('no capacity at all means no percentage, but the traffic is still reported', () => {
    const d = aggregateDeviceBandwidth([sample(10, 1, 5e6, 6e6, 0, 0)]).get(1)
    assert.equal(d.inBps, 5e6)
    assert.equal(d.utilInPct, null)
    assert.equal(d.utilOutPct, null)
  })

  test('real zero traffic is 0, with a percentage', () => {
    const d = aggregateDeviceBandwidth([sample(10, 1, 0, 0, G)]).get(1)
    assert.equal(d.inBps, 0)
    assert.equal(d.utilInPct, 0)
  })

  test('in and out are independent', () => {
    const d = aggregateDeviceBandwidth([sample(10, 1, 100e6, null, G, G)]).get(1)
    assert.equal(d.inBps, 100e6)
    assert.equal(d.utilInPct, 10)
    assert.equal(d.outBps, null)
    assert.equal(d.utilOutPct, null)
  })

  test('traffic above the line rate is reported as is, not clamped', () => {
    const d = aggregateDeviceBandwidth([sample(10, 1, 1.5 * G, 0, G)]).get(1)
    assert.equal(d.utilInPct, 150)
  })

  test('devices are kept apart', () => {
    const m = aggregateDeviceBandwidth([sample(10, 1, 100e6, 0, G, G, 1), sample(20, 1, 700e6, 0, G, G, 2)])
    assert.equal(m.get(1).utilInPct, 10)
    assert.equal(m.get(2).utilInPct, 70)
    assert.equal(m.size, 2)
  })

  test('entries that are not samples are skipped', () => {
    const d = aggregateDeviceBandwidth([null, undefined, sample(10, 1, 100e6, 0, G)]).get(1)
    assert.equal(d.interfaces, 1)
  })
})

// Threshold rules fire per interface, so the device's combined percentage can
// read 0.4% while one interface is over 30%. The busiest interface explains
// the marker's color: the one with the highest utilization in either direction.
describe('aggregateDeviceBandwidth: busiest interface', () => {
  const named = (name, ...args) => ({ ...sample(...args), interfaceName: name })

  test('the interface with the highest utilization, in or out, with both its figures', () => {
    const d = aggregateDeviceBandwidth([
      named('Et0/0', 10, 1, 200e6, 50e6, G),
      named('Et0/1', 11, 1, 10e6, 308e6, G),
      named('Et0/2', 12, 1, 0, 0, G),
    ]).get(1)
    assert.deepEqual(d.busiest, { interfaceId: 11, name: 'Et0/1', utilInPct: 1, utilOutPct: 30.8 })
  })

  test('ranked by percentage, not traffic: a full slow link beats a busier fast one', () => {
    const d = aggregateDeviceBandwidth([
      named('fast', 10, 1, 500e6, 0, 10 * G),
      named('slow', 11, 1, 90e6, 0, 100e6),
    ]).get(1)
    assert.equal(d.busiest.name, 'slow')
    assert.equal(d.busiest.utilInPct, 90)
  })

  test('only the newest sample of each interface counts', () => {
    const d = aggregateDeviceBandwidth([
      named('old-peak', 10, 1, 900e6, 0, G),
      named('old-peak', 10, 2, 10e6, 0, G),
      named('steady', 11, 2, 50e6, 0, G),
    ]).get(1)
    assert.equal(d.busiest.name, 'steady')
  })

  test('an interface without a speed has no percentage and cannot be the busiest', () => {
    const d = aggregateDeviceBandwidth([named('unrated', 10, 1, 900e6, 0, 0), named('rated', 11, 1, 1e6, 0, G)]).get(1)
    assert.equal(d.busiest.name, 'rated')
  })

  test('a direction that was not measured is null, and the other still ranks', () => {
    const d = aggregateDeviceBandwidth([named('a', 10, 1, null, 400e6, G), named('b', 11, 1, 100e6, 100e6, G)]).get(1)
    assert.deepEqual(d.busiest, { interfaceId: 10, name: 'a', utilInPct: null, utilOutPct: 40 })
  })

  test('no interface with a percentage: null, not an interface at 0%', () => {
    assert.equal(aggregateDeviceBandwidth([named('u', 10, 1, 5e6, 5e6, 0)]).get(1).busiest, null)
    assert.equal(aggregateDeviceBandwidth([named('m', 10, 1, null, null, G)]).get(1).busiest, null)
  })

  test('an idle device still names its busiest interface, at 0%', () => {
    assert.deepEqual(aggregateDeviceBandwidth([named('idle', 10, 1, 0, 0, G)]).get(1).busiest,
      { interfaceId: 10, name: 'idle', utilInPct: 0, utilOutPct: 0 })
  })

  test('a tie goes to the lower interface id, whatever the input order', () => {
    const a = named('a', 10, 1, 100e6, 0, G)
    const b = named('b', 11, 1, 100e6, 0, G)
    assert.equal(aggregateDeviceBandwidth([b, a]).get(1).busiest.name, 'a')
    assert.equal(aggregateDeviceBandwidth([a, b]).get(1).busiest.name, 'a')
  })

  test('without a name the interface is still reported, name null', () => {
    assert.equal(aggregateDeviceBandwidth([sample(10, 1, 100e6, 0, G)]).get(1).busiest.name, null)
  })

  test('devices are kept apart', () => {
    const m = aggregateDeviceBandwidth([named('x', 10, 1, 100e6, 0, G, G, 1), named('y', 20, 1, 700e6, 0, G, G, 2)])
    assert.equal(m.get(1).busiest.name, 'x')
    assert.equal(m.get(2).busiest.name, 'y')
  })
})

describe('pickAvailability', () => {
  test('availability when the device reports it', () => {
    assert.deepEqual(pickAvailability({ availability: 99.5, reachability: 100 }), { value: 99.5, kind: 'availability' })
  })

  test('availability of 0 is a real value, not "missing"', () => {
    assert.deepEqual(pickAvailability({ availability: 0, reachability: 100 }), { value: 0, kind: 'availability' })
  })

  test('falls back to reachability, labelled as such', () => {
    assert.deepEqual(pickAvailability({ availability: null, reachability: 87 }), { value: 87, kind: 'reachability' })
    assert.deepEqual(pickAvailability({ reachability: 87 }), { value: 87, kind: 'reachability' })
  })

  test('neither reported: no value, no invented 100%', () => {
    assert.deepEqual(pickAvailability({}), { value: null, kind: null })
    assert.deepEqual(pickAvailability({ availability: null, reachability: null }), { value: null, kind: null })
    assert.deepEqual(pickAvailability(undefined), { value: null, kind: null })
    assert.deepEqual(pickAvailability(null), { value: null, kind: null })
  })

  test('non-numbers are not values', () => {
    assert.deepEqual(pickAvailability({ availability: 'n/a', reachability: Number.NaN }), { value: null, kind: null })
    assert.deepEqual(pickAvailability({ availability: '', reachability: '' }), { value: null, kind: null })
  })

  test('numeric strings from CSV are accepted', () => {
    assert.deepEqual(pickAvailability({ availability: '98.2' }), { value: 98.2, kind: 'availability' })
  })
})

// The customer's ask (2026-11-06): bandwidth must come from the ISP / external WAN circuits, shown
// per circuit, not averaged over every interface on the device. The circuits are the members of a
// PC interface group (metrics.wanGroup). Inputs: that group's `interfaces` rows for the map's
// devices (ID, Name, Alias, SpeedIn/Out, DeviceItemID) and portmfs samples (normalizePortSample).
describe('wanCircuitsByDevice (the WAN circuits list)', () => {
  const iface = (id, device, name, over = {}) => ({ ID: id, DeviceItemID: device, Name: name, Alias: null, SpeedIn: 50e6, SpeedOut: 50e6, ...over })
  const smp = (id, device, t, inBps, outBps, speed = 50e6) => ({ deviceId: device, interfaceId: id, interfaceName: null, t, inBps, outBps, speedInBps: speed, speedOutBps: speed })

  test('one circuit per group interface, by device, with its own In / Out utilization and speed', () => {
    const m = wanCircuitsByDevice([iface(1, 7, 'ge0/0'), iface(2, 7, 'ge0/1')], [smp(1, 7, 100, 21e6, 6e6), smp(2, 7, 100, 5e6, 10e6)])
    assert.deepEqual(m.get(7), [
      { interfaceId: 1, name: 'ge0/0', alias: null, sampled: true, inBps: 21e6, outBps: 6e6, speedInBps: 50e6, speedOutBps: 50e6, inPct: 42, outPct: 12 },
      { interfaceId: 2, name: 'ge0/1', alias: null, sampled: true, inBps: 5e6, outBps: 10e6, speedInBps: 50e6, speedOutBps: 50e6, inPct: 10, outPct: 20 },
    ])
  })
  test('the newest sample of each circuit counts, in any order', () => {
    const m = wanCircuitsByDevice([iface(1, 7, 'ge0/0')], [smp(1, 7, 300, 5e6, 0), smp(1, 7, 100, 45e6, 0), smp(1, 7, 200, 40e6, 0)])
    assert.equal(m.get(7)[0].inPct, 10)
  })
  test('a circuit with no sample is listed as not sampled — no 0 % invented', () => {
    const c = wanCircuitsByDevice([iface(1, 7, 'vni-0/0.0')], []).get(7)[0]
    assert.equal(c.sampled, false)
    for (const k of ['inPct', 'outPct', 'inBps', 'outBps']) assert.equal(c[k], null, k)
    assert.equal(c.speedInBps, 50e6)
  })
  test('a direction with no traffic value has no percentage; the other still does', () => {
    const c = wanCircuitsByDevice([iface(1, 7, 'a')], [smp(1, 7, 1, null, 25e6)]).get(7)[0]
    assert.equal(c.inPct, null)
    assert.equal(c.outPct, 50)
  })
  test('speed: the sample\'s, else the inventory\'s; megabit values are scaled; none means no percentage', () => {
    const fromSample = wanCircuitsByDevice([iface(1, 7, 'a', { SpeedIn: 1e9, SpeedOut: 1e9 })], [smp(1, 7, 1, 25e6, 0, 50e6)]).get(7)[0]
    assert.equal(fromSample.inPct, 50)
    const fromInventory = wanCircuitsByDevice([iface(1, 7, 'a', { SpeedIn: 100, SpeedOut: 100 })], [smp(1, 7, 1, 25e6, 0, 0)]).get(7)[0]
    assert.equal(fromInventory.speedInBps, 100e6)
    assert.equal(fromInventory.inPct, 25)
    const none = wanCircuitsByDevice([iface(1, 7, 'a', { SpeedIn: null, SpeedOut: 0 })], [smp(1, 7, 1, 25e6, 3e6, 0)]).get(7)[0]
    assert.equal(none.inPct, null)
    assert.equal(none.inBps, 25e6)
  })
  test('worst circuit first (by its higher direction); not-sampled last; ties by name', () => {
    const m = wanCircuitsByDevice(
      [iface(1, 7, 'b'), iface(2, 7, 'a'), iface(3, 7, 'z-down'), iface(4, 7, 'c')],
      [smp(1, 7, 1, 5e6, 40e6), smp(2, 7, 1, 5e6, 40e6), smp(4, 7, 1, 45e6, 0)])
    assert.deepEqual(m.get(7).map((c) => c.name), ['c', 'a', 'b', 'z-down'])
  })
  test('a sampled circuit with no percentage (unknown speed) still comes before an unsampled one', () => {
    const m = wanCircuitsByDevice(
      [iface(1, 7, 'a-unsampled'), iface(2, 7, 'z-no-speed', { SpeedIn: 0, SpeedOut: 0 })],
      [smp(2, 7, 1, 10e6, 10e6, 0)])
    assert.deepEqual(m.get(7).map((c) => c.name), ['z-no-speed', 'a-unsampled'])
  })
  test('the alias is kept, blank is null', () => {
    const m = wanCircuitsByDevice([iface(1, 7, 'a', { Alias: 'WAN interface: ISP-1' }), iface(2, 7, 'b', { Alias: '  ' })], [])
    assert.deepEqual(m.get(7).map((c) => c.alias), ['WAN interface: ISP-1', null])
  })
  test('samples of interfaces outside the group are ignored; devices kept apart', () => {
    const m = wanCircuitsByDevice([iface(1, 7, 'a'), iface(2, 8, 'b')], [smp(9, 7, 1, 50e6, 50e6), smp(2, 8, 1, 10e6, 0)])
    assert.equal(m.get(7).length, 1)
    assert.equal(m.get(7)[0].sampled, false)
    assert.equal(m.get(8)[0].inPct, 20)
  })
  test('traffic above the line rate reads above 100 (not clamped)', () => {
    assert.equal(wanCircuitsByDevice([iface(1, 7, 'a')], [smp(1, 7, 1, 60e6, 0)]).get(7)[0].inPct, 120)
  })
  test('bad input: an empty map; rows without an id or device are skipped', () => {
    assert.equal(wanCircuitsByDevice(null, null).size, 0)
    assert.equal(wanCircuitsByDevice([{ Name: 'x' }, iface(1, null, 'y')], []).size, 0)
  })
})
