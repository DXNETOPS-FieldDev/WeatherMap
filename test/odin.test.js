// Unit tests for the outage counting in src/api/odin.js — run with `npm test`.
//
// The Power Outages label counts the outages people actually see in device
// popups: each device's "Possible power outage" banner shows one outage (the
// most severe containing it, chosen by correlateOutagesToDevices), and the
// label counts the distinct ones. It deliberately does NOT count every outage
// record overlapping a device: ODIN's feed is county-level and stacks many
// records on one county (54 in Harris County, TX at one point), which inflated
// the count to 70 of 88 devices.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bannerOutageCount, correlateOutagesToDevices } from '../src/api/odin.js'

const square = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]
const outage = (name, coordinates, metersaffected = 1) => ({ name, metersaffected, geom: { type: 'Polygon', coordinates } })
const device = (id, longitude, latitude) => ({ id, longitude, latitude })

// What App.jsx does: attach each device's banner outage, then count.
function decorate(devices, outages) {
  const map = correlateOutagesToDevices(devices, outages)
  return devices.map((d) => ({ ...d, outage: map.get(d.id) || null }))
}

describe('bannerOutageCount (the Power Outages label count)', () => {
  test('one device under an outage counts 1', () => {
    assert.equal(bannerOutageCount(decorate([device(1, 5, 5)], [outage('a', square(0, 0, 10, 10))])), 1)
  })

  test('stacked records over one county count once — the device shows one banner', () => {
    const stacked = Array.from({ length: 54 }, (_, i) => outage(`harris-${i}`, square(0, 0, 10, 10), i))
    assert.equal(bannerOutageCount(decorate([device(1, 5, 5)], stacked)), 1)
  })

  test('several devices showing the same outage count it once', () => {
    const o = outage('a', square(0, 0, 10, 10))
    assert.equal(bannerOutageCount(decorate([device(1, 1, 1), device(2, 5, 5), device(3, 9, 9)], [o])), 1)
  })

  test('devices showing different outages count each', () => {
    const a = outage('a', square(0, 0, 10, 10))
    const b = outage('b', square(50, 50, 60, 60))
    assert.equal(bannerOutageCount(decorate([device(1, 5, 5), device(2, 55, 55)], [a, b])), 2)
  })

  test('an outage over no device is not counted', () => {
    const far = outage('far', square(50, 50, 60, 60))
    assert.equal(bannerOutageCount(decorate([device(1, 5, 5)], [far])), 0)
  })

  test('only the devices passed in count (the filter decides what is passed)', () => {
    const a = outage('a', square(0, 0, 10, 10))
    const b = outage('b', square(50, 50, 60, 60))
    const all = decorate([device(1, 5, 5), device(2, 55, 55)], [a, b])
    assert.equal(bannerOutageCount(all.filter((d) => d.id === 1)), 1)
  })

  test('no devices, or devices without an outage, count 0', () => {
    assert.equal(bannerOutageCount([]), 0)
    assert.equal(bannerOutageCount(null), 0)
    assert.equal(bannerOutageCount([{ id: 1, outage: null }, { id: 2 }, null]), 0)
  })
})
