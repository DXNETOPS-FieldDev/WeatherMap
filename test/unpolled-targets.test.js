// Unit tests for hiding records that aren't monitored devices (src/api/odata.js) — run with `npm test`.
//
// PC lists AppNeta path targets (e.g. "seattle-isp-2", a web site) as devices in the group. They have no IP
// address, no protocols and nothing polled. test/fixtures/devices-polled.csv is a REAL devices-query CSV
// response captured 2026-11-24 (7 of its 109 rows), with lab names and addresses replaced by examples.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Papa from 'papaparse'
import { normalizeDevice, isAppNetaDevice } from '../src/api/odata.js'

const csv = readFileSync(new URL('./fixtures/devices-polled.csv', import.meta.url), 'utf8')
const rows = Papa.parse(csv, { header: true, dynamicTyping: true, skipEmptyLines: true }).data
const devices = rows.map(normalizeDevice)
const byName = new Map(devices.map((d) => [d.name, d]))
const hidden = (name) => isAppNetaDevice(byName.get(name))

describe('records that are not monitored devices', () => {
  test('the fixture parsed: 7 rows', () => assert.equal(devices.length, 7))

  test('normalizeDevice reads protocols and polled-item count', () => {
    assert.equal(byName.get('router-2.example.com').protocols, 'SNMP;ICMP')
    assert.equal(byName.get('router-2.example.com').polledItems, 42)
    assert.equal(byName.get('seattle-isp-2').protocols, '')
    assert.equal(byName.get('seattle-isp-2').polledItems, 0)
  })

  test('an AppNeta path target (no IP, no protocols, nothing polled) is hidden', () => {
    assert.equal(hidden('seattle-isp-2'), true)
    assert.equal(hidden('web.example.com'), true)
  })

  test('AppNeta monitoring points are still hidden by name', () => {
    assert.equal(hidden('vk35-seattle-appneta'), true)
  })

  test('a record with no IP but something polled is kept', () => {
    assert.equal(hidden('cluster01-vrops1'), false)
  })

  test('an ICMP-only device with nothing polled yet is kept (it has an IP)', () => {
    assert.equal(hidden('den-hq-ap-f1-01'), false)
  })

  test('ordinary devices are kept', () => {
    assert.equal(hidden('router-2.example.com'), false)
    assert.equal(hidden('vnf-001-newyork'), false)
  })

  test('a row from an older query without the two columns is kept (unknown is not "unpolled")', () => {
    assert.equal(isAppNetaDevice({ name: 'x', ip: '', protocols: undefined, polledItems: null }), false)
  })
})
