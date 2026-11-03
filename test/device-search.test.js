// Unit tests for src/lib/device-search.js — run with `npm test`.
//
// The map's "Find device…" box matches what is drawn by name or IP. Same rules
// as BandwidthMap's box: a name that starts with the text outranks one that
// merely contains it, which outranks an IP match; ties are alphabetical.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { matchDevices } from '../src/lib/device-search.js'

const d = (id, name, ip) => ({ id, name, ip })
const ids = (hits) => hits.map((h) => h.id)

describe('matchDevices', () => {
  const devices = [
    d(1, 'core-sw-01', '10.0.0.1'),
    d(2, 'edge-router-ce2', '10.0.0.2'),
    d(3, 'CE1.mydomain.com', '10.0.1.1'),
    d(4, 'CE2.mydomain.com', '10.0.1.2'),
    d(5, 'atlanta-ce2-backup', '192.168.5.5'),
  ]

  test('blank, whitespace, null and undefined queries match nothing', () => {
    for (const q of ['', '   ', null, undefined]) assert.deepEqual(matchDevices(devices, q), [], `query ${JSON.stringify(q)}`)
  })

  test('not a list of devices means no hits', () => {
    for (const v of [null, undefined, 'x', 5, {}]) assert.deepEqual(matchDevices(v, 'ce'), [])
  })

  test('case-insensitive on names', () => {
    assert.deepEqual(ids(matchDevices(devices, 'ce1')), [3])
    assert.deepEqual(ids(matchDevices(devices, 'CE1')), [3])
  })

  test('surrounding spaces in the query are ignored', () => {
    assert.deepEqual(ids(matchDevices(devices, '  ce1  ')), [3])
  })

  test('a name starting with the text outranks one containing it', () => {
    assert.deepEqual(ids(matchDevices(devices, 'ce2')), [4, 5, 2])
  })

  test('IP matches rank after name matches', () => {
    // '10.0.1' only appears in IPs; '1' is in names and IPs: the name hits (core-sw-01, CE1.…) come first.
    assert.deepEqual(ids(matchDevices(devices, '10.0.1')), [3, 4])
    const hits = ids(matchDevices(devices, '1'))
    assert.deepEqual(hits.slice(0, 2).sort(), [1, 3].sort(), 'name hits first')
    assert.ok(hits.includes(2) && hits.includes(4) && hits.includes(5), 'IP-only hits follow')
  })

  test('ties are alphabetical by name', () => {
    const ds = [d(1, 'gw-b', ''), d(2, 'gw-a', ''), d(3, 'gw-c', '')]
    assert.deepEqual(ids(matchDevices(ds, 'gw')), [2, 1, 3])
  })

  test('the query is literal text, not a pattern', () => {
    const ds = [d(1, 'axb', '1.1.1.1'), d(2, 'a.b', '1.1.1.2'), d(3, 'a(b', '1.1.1.3')]
    assert.deepEqual(ids(matchDevices(ds, 'a.b')), [2])
    assert.deepEqual(ids(matchDevices(ds, 'a(b')), [3])
    assert.deepEqual(ids(matchDevices(ds, '.*')), [])
  })

  test('devices with no name or no IP never throw', () => {
    const ds = [d(1, null, '10.0.0.1'), d(2, 'host', undefined), { id: 3 }, d(4, 'host2', null)]
    assert.deepEqual(ids(matchDevices(ds, 'host')), [2, 4])
    assert.deepEqual(ids(matchDevices(ds, '10.0.0.1')), [1])
  })

  test('hits are capped at 10 by default, or at the given limit', () => {
    const many = Array.from({ length: 40 }, (_, i) => d(i, `sw-${String(i).padStart(2, '0')}`, ''))
    assert.equal(matchDevices(many, 'sw').length, 10)
    assert.equal(matchDevices(many, 'sw', 3).length, 3)
    assert.deepEqual(ids(matchDevices(many, 'sw', 3)), [0, 1, 2])
  })

  test('returns the device objects themselves', () => {
    const hit = matchDevices(devices, 'core')[0]
    assert.equal(hit, devices[0])
  })

  test('5,000 devices answer well inside a keystroke', () => {
    const big = Array.from({ length: 5000 }, (_, i) => d(i, `site-${i}-rtr`, `10.${i % 250}.${i % 7}.1`))
    const t0 = performance.now()
    const hits = matchDevices(big, 'site-49')
    const ms = performance.now() - t0
    assert.equal(hits.length, 10)
    assert.ok(ms < 250, `took ${Math.round(ms)} ms`)
  })
})
