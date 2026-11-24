// Unit tests for the Metrics tab's Availability / Reachability line (src/api/odata.js) — run with `npm test`.
//
// Parsing uses REAL PC OData responses captured 2026-11-24 (test/fixtures/availability.json): a device up
// (both families), a device down (reachability 0, no availability — PC shows it NOT REACHABLE), a device
// with neither, and one with availability only counting.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fillAvailability } from '../src/api/odata.js'

const capture = JSON.parse(readFileSync(new URL('./fixtures/availability.json', import.meta.url)))
const avResp = capture.availabilitymfs.response
const reResp = capture.reachabilitymfs.response
const WINDOW = { startTime: 1795534955, endTime: 1795538555 }
const okJson = (body) => ({ ok: true, status: 200, json: async () => body })
const quiet = { warn: () => {} }
const device = (id) => ({ id, name: `d${id}`, cpu: null, memory: null })
const route = (calls, { failAv, failRe } = {}) => async (url) => {
  calls.push(url)
  if (url.includes('/availabilitymfs?')) return failAv ? { ok: false, status: 500 } : okJson(avResp)
  return failRe ? { ok: false, status: 500 } : okJson(reResp)
}
const fill = (devs, opts = {}) => fillAvailability(devs, WINDOW, { fetchImpl: route(opts.calls ?? [], opts), resolution: 'RATE', log: opts.log ?? quiet })

describe('fillAvailability (real responses)', () => {
  test('a device that is up: Availability, from availabilitymfs', async () => {
    const [d] = await fill([device(309675)])
    assert.deepEqual(d.availability, { value: 100, kind: 'availability' })
  })

  test('a device that is down: Reachability 0 %, since PC computes no availability for it', async () => {
    const [d] = await fill([device(309682)])
    assert.deepEqual(d.availability, { value: 0, kind: 'reachability' })
  })

  test('availability wins over reachability when both are reported', async () => {
    const [d] = await fill([device(1202322)])
    assert.deepEqual(d.availability, { value: 100, kind: 'availability' })
  })

  test('neither reported: null ("not available"), never 0', async () => {
    const [d] = await fill([device(7116)])
    assert.equal(d.availability, null)
  })

  test('availability is asked for every device, reachability only for those still missing', async () => {
    const calls = []
    await fill([device(309675), device(309682), device(7116)], { calls })
    const filterOf = (set) => new URL(calls.find((c) => c.includes(`/${set}?`)), 'https://p.example').searchParams
    assert.equal(filterOf('availabilitymfs').get('$filter'), 'DeviceItemID in (309675,309682,7116)')
    assert.equal(filterOf('reachabilitymfs').get('$filter'), 'DeviceItemID in (309682,7116)')
    assert.equal(filterOf('availabilitymfs').get('$apply'), 'groupby((DeviceItemID),aggregate(im_Availability with average as Value))')
    assert.equal(filterOf('reachabilitymfs').get('$apply'), 'groupby((DeviceItemID),aggregate(im_Reachability with average as Value))')
  })

  test('batches of 40 ids', async () => {
    const calls = []
    await fill(Array.from({ length: 85 }, (_, i) => device(1000 + i)), { calls })
    assert.equal(calls.filter((c) => c.includes('/availabilitymfs?')).length, 3)
  })

  test('availability query failing: reachability is still tried, and the failure is logged', async () => {
    const warned = []
    const [up, down] = await fill([device(309675), device(309682)], { failAv: true, log: { warn: (m) => warned.push(m) } })
    assert.deepEqual(up.availability, { value: 100, kind: 'reachability' })
    assert.deepEqual(down.availability, { value: 0, kind: 'reachability' })
    assert.ok(warned.length >= 1)
  })

  test('both failing: every device keeps availability null, nothing thrown', async () => {
    const devs = await fill([device(309675)], { failAv: true, failRe: true })
    assert.equal(devs[0].availability, null)
  })

  test('no devices: no request', async () => {
    const calls = []
    assert.deepEqual(await fill([], { calls }), [])
    assert.equal(calls.length, 0)
  })
})
