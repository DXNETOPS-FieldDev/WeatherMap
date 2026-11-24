// Unit tests for the CPU / memory fallback to component metrics (src/api/odata.js) — run with `npm test`.
//
// Some devices report CPU and memory only per component (per CPU in cpumfs, per memory pool in memorymfs),
// not in the device-level cpuandmemorymfs the devices query reads. The parsing tests use REAL PC OData
// responses captured 2026-11-24 (test/fixtures/component-metrics.json, unedited apart from the context URL).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { componentMetricsQuery, parseComponentMetrics, fillComponentMetrics } from '../src/api/odata.js'

const capture = JSON.parse(readFileSync(new URL('./fixtures/component-metrics.json', import.meta.url)))
const cpuResp = capture.cpumfs.response
const memResp = capture.memorymfs.response
const WINDOW = { startTime: 1795534955, endTime: 1795538555 }
const okJson = (body) => ({ ok: true, status: 200, json: async () => body })
const quiet = { warn: () => {} }
const device = (id, cpu = null, memory = null) => ({ id, name: `d${id}`, cpu, memory, disk: null })

describe('parseComponentMetrics (real responses)', () => {
  const cpu = parseComponentMetrics(cpuResp)
  const mem = parseComponentMetrics(memResp)

  test('one value per device, keyed by DeviceItemID', () => {
    assert.equal(cpu.size, 4)
    assert.equal(cpu.get(309675), 0)
    assert.equal(mem.get(309675), 88.2137617211858)
  })

  test('a device with many CPUs / pools gets their average, as PC\'s own gauges show (50.26% / 49.43%)', () => {
    assert.equal(cpu.get(309671).toFixed(2), '50.26')
    assert.equal(mem.get(309671).toFixed(2), '49.43')
  })

  test('0% is a value, not missing', () => {
    assert.equal(cpu.has(13975), true)
    assert.equal(cpu.get(13975), 0)
  })

  test('null (not collected) is left out, so it shows as "not available", never 0', () => {
    assert.equal(mem.has(13975), false)
  })

  test('a device with no component data is absent', () => {
    assert.equal(cpu.has(309682), false)
    assert.equal(mem.has(309682), false)
  })

  test('empty or malformed input gives an empty map', () => {
    assert.equal(parseComponentMetrics(null).size, 0)
    assert.equal(parseComponentMetrics({}).size, 0)
  })
})

describe('componentMetricsQuery', () => {
  const u = new URL(componentMetricsQuery('cpumfs', [309675, 309671], WINDOW, 'RATE'), 'https://portal.example')

  test('the component family, only the listed devices, averaged per device over the window', () => {
    assert.equal(u.pathname, '/pc/odata4/api/cpumfs')
    assert.equal(u.searchParams.get('$filter'), 'DeviceItemID in (309675,309671)')
    assert.equal(u.searchParams.get('$apply'), 'groupby((DeviceItemID),aggregate(im_Utilization with average as Value))')
    assert.equal(u.searchParams.get('starttime'), '1795534955')
    assert.equal(u.searchParams.get('endtime'), '1795538555')
    assert.equal(u.searchParams.get('resolution'), 'RATE')
    assert.equal(u.searchParams.get('$format'), 'application/json')
  })
})

describe('fillComponentMetrics', () => {
  const route = (calls, { fail } = {}) => async (url) => {
    calls.push(url)
    if (fail) return { ok: false, status: 500 }
    return okJson(url.includes('/cpumfs?') ? cpuResp : memResp)
  }

  test('fills CPU and memory for devices that have no device-level values', async () => {
    const calls = []
    const out = await fillComponentMetrics([device(309675), device(309671)], WINDOW, { fetchImpl: route(calls), resolution: 'RATE', log: quiet })
    assert.equal(out[0].cpu, 0)
    assert.equal(out[0].memory, 88.2137617211858)
    assert.equal(out[1].cpu.toFixed(2), '50.26')
  })

  test('device-level values are kept, never overwritten', async () => {
    const out = await fillComponentMetrics([device(7115, 2, 31)], WINDOW, { fetchImpl: route([]), resolution: 'RATE', log: quiet })
    assert.equal(out[0].cpu, 2)
    assert.equal(out[0].memory, 31)
  })

  test('only devices missing a value are queried, per family', async () => {
    const calls = []
    await fillComponentMetrics([device(7115, 2, null), device(309675)], WINDOW, { fetchImpl: route(calls), resolution: 'RATE', log: quiet })
    const filterOf = (set) => new URL(calls.find((c) => c.includes(`/${set}?`)), 'https://p.example').searchParams.get('$filter')
    assert.equal(filterOf('cpumfs'), 'DeviceItemID in (309675)')
    assert.equal(filterOf('memorymfs'), 'DeviceItemID in (7115,309675)')
  })

  test('nothing missing: no request at all', async () => {
    const calls = []
    const out = await fillComponentMetrics([device(7115, 2, 31)], WINDOW, { fetchImpl: route(calls), resolution: 'RATE', log: quiet })
    assert.equal(calls.length, 0)
    assert.equal(out[0].cpu, 2)
  })

  test('still missing after the fallback: stays null ("not available")', async () => {
    const out = await fillComponentMetrics([device(13975), device(309682)], WINDOW, { fetchImpl: route([]), resolution: 'RATE', log: quiet })
    assert.equal(out[0].cpu, 0)
    assert.equal(out[0].memory, null)
    assert.equal(out[1].cpu, null)
    assert.equal(out[1].memory, null)
  })

  test('many devices are split into batches', async () => {
    const calls = []
    const many = Array.from({ length: 450 }, (_, i) => device(1000 + i))
    await fillComponentMetrics(many, WINDOW, { fetchImpl: route(calls), resolution: 'RATE', log: quiet, batchSize: 200 })
    assert.equal(calls.filter((c) => c.includes('/cpumfs?')).length, 3)
    assert.equal(calls.filter((c) => c.includes('/memorymfs?')).length, 3)
  })

  test('a failing query leaves the devices as they were and is logged, not thrown', async () => {
    const warned = []
    const devs = [device(309675), device(7115, 2, 31)]
    const out = await fillComponentMetrics(devs, WINDOW, { fetchImpl: route([], { fail: true }), resolution: 'RATE', log: { warn: (m) => warned.push(m) } })
    assert.deepEqual(out, devs)
    assert.ok(warned.length >= 1)
  })
})
