// Unit tests for src/lib/gateways.js — run with `npm test`.
//
// "Gateways" are devices outside the dashboard's group that the group's devices
// tunnel to (e.g. a client's four SD-WAN hubs; ~350 site groups each tunnel to
// one). WeatherMap draws tunnels only when both ends are on the map, so a site
// group showed none. The deployment lists its gateways in runtime-config.json
// (names or numeric PC device IDs); this module parses that list, builds the
// OData filter that fetches them, decides which to draw, and explains in plain
// words why a configured gateway isn't showing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_GATEWAY_REFS,
  parseGatewayRefs,
  gatewayFilter,
  gatewayStatuses,
  gatewaysToShow,
} from '../src/lib/gateways.js'

const EMPTY = { ids: [], names: [], truncated: false }

// Shapes as WeatherMap holds them after normalizeDevice / normalize(tunnel).
const dev = (id, name, lat = 40, lng = -75) => ({ id, name, latitude: lat, longitude: lng })
const tun = (id, sourceId, destId) => ({ id, sourceId, destId })

describe('parseGatewayRefs', () => {
  test('anything that is not a list means "no gateways"', () => {
    for (const v of [undefined, null, 'SIN-GW-01', 7114, {}, true]) {
      assert.deepEqual(parseGatewayRefs(v), EMPTY, `input ${JSON.stringify(v)}`)
    }
  })

  test('empty list', () => {
    assert.deepEqual(parseGatewayRefs([]), EMPTY)
  })

  test('names and numeric ids are separated; digits-only strings are ids', () => {
    const r = parseGatewayRefs(['SIN-GW-01', 7114, '7115', '  7116  ', 'MTL-GW-02'])
    assert.deepEqual(r.ids, [7114, 7115, 7116])
    assert.deepEqual(r.names, ['SIN-GW-01', 'MTL-GW-02'])
  })

  test('names are trimmed; an IP-like or dotted name stays a name', () => {
    const r = parseGatewayRefs(['  SIN-GW-01  ', '10.1.1.1', 'gw.example.com'])
    assert.deepEqual(r.names, ['SIN-GW-01', '10.1.1.1', 'gw.example.com'])
    assert.deepEqual(r.ids, [])
  })

  test('junk entries are ignored', () => {
    const r = parseGatewayRefs(['', '   ', null, undefined, 1.5, -3, 0, {}, [], true, Number.NaN, 2 ** 60, 'ok'])
    assert.deepEqual(r.ids, [])
    assert.deepEqual(r.names, ['ok'])
  })

  test('duplicates collapse; names compare ignoring case, first spelling wins', () => {
    const r = parseGatewayRefs([7114, '7114', 'SIN-GW-01', 'sin-gw-01', ' SIN-GW-01 '])
    assert.deepEqual(r.ids, [7114])
    assert.deepEqual(r.names, ['SIN-GW-01'])
  })

  test('the list is capped (long OR lists fail with HTTP 400): exactly the cap is fine, one more truncates', () => {
    const exactly = Array.from({ length: MAX_GATEWAY_REFS }, (_, i) => i + 1)
    const a = parseGatewayRefs(exactly)
    assert.equal(a.ids.length, MAX_GATEWAY_REFS)
    assert.equal(a.truncated, false)

    const b = parseGatewayRefs([...exactly, MAX_GATEWAY_REFS + 1])
    assert.equal(b.ids.length, MAX_GATEWAY_REFS)
    assert.equal(b.truncated, true)
    assert.deepEqual(b.ids, exactly, 'the first entries are the ones kept')
  })

  test('the cap counts ids and names together', () => {
    const mixed = Array.from({ length: MAX_GATEWAY_REFS + 5 }, (_, i) => (i % 2 ? `gw-${i}` : i + 1))
    const r = parseGatewayRefs(mixed)
    assert.equal(r.ids.length + r.names.length, MAX_GATEWAY_REFS)
    assert.equal(r.truncated, true)
  })
})

describe('gatewayFilter', () => {
  test('nothing configured means no filter at all', () => {
    assert.equal(gatewayFilter(EMPTY), null)
    assert.equal(gatewayFilter(undefined), null)
    assert.equal(gatewayFilter({}), null)
  })

  test('ids only', () => {
    assert.equal(gatewayFilter({ ids: [7114, 7115], names: [] }), '(ID eq 7114 or ID eq 7115)')
  })

  test('names only', () => {
    assert.equal(gatewayFilter({ ids: [], names: ['A', 'B'] }), "(Name eq 'A' or Name eq 'B')")
  })

  test('ids first, then names', () => {
    assert.equal(gatewayFilter({ ids: [7114], names: ['A'] }), "(ID eq 7114 or Name eq 'A')")
  })

  test("a quote inside a name is doubled (O'Hare)", () => {
    assert.equal(gatewayFilter({ ids: [], names: ["O'Hare-GW"] }), "(Name eq 'O''Hare-GW')")
  })

  test('an injection attempt stays one literal', () => {
    const nasty = ["x' or 1 eq 1 or Name eq 'y", "'", "''", "a'b'c", "x') or (1 eq 1"]
    for (const name of nasty) {
      const f = gatewayFilter({ ids: [], names: [name] })
      const m = f.match(/^\(Name eq '((?:[^']|'')*)'\)$/)
      assert.ok(m, `not a single quoted literal: ${f}`)
      assert.equal(m[1].replace(/''/g, "'"), name, 'unescaping gives back the original name')
    }
  })

  test('only safe integers get into the ID part', () => {
    const f = gatewayFilter({ ids: [7114, Number.NaN, 1.5, -2, 2 ** 60, '7;drop'], names: [] })
    assert.equal(f, '(ID eq 7114)')
  })

  test('ids all dropped and no names means no filter', () => {
    assert.equal(gatewayFilter({ ids: [Number.NaN], names: [] }), null)
  })
})

describe('gatewaysToShow', () => {
  const SIN = dev(1, 'SIN-GW-01')
  const MTL = dev(2, 'MTL-GW-01')
  const inGroup = new Set([100, 101])

  test('a gateway the group tunnels to is shown, flagged as a gateway', () => {
    const out = gatewaysToShow({ gateways: [SIN, MTL], tunnels: [tun(10, 100, 1)], groupDeviceIds: inGroup })
    assert.deepEqual(out.map((d) => d.id), [1])
    assert.equal(out[0].gateway, true)
    assert.equal(out[0].name, 'SIN-GW-01')
  })

  test('a gateway with no tunnel from the group is hidden', () => {
    const out = gatewaysToShow({ gateways: [SIN, MTL], tunnels: [tun(10, 100, 1)], groupDeviceIds: inGroup })
    assert.ok(!out.some((d) => d.id === 2))
  })

  test('show-all brings back the hidden one', () => {
    const out = gatewaysToShow({ gateways: [SIN, MTL], tunnels: [tun(10, 100, 1)], groupDeviceIds: inGroup, showAll: true })
    assert.deepEqual(out.map((d) => d.id), [1, 2])
  })

  test('a gateway already in the group is not drawn twice, even with show-all', () => {
    const grp = new Set([100, 1])
    const tunnels = [tun(10, 100, 1)]
    assert.deepEqual(gatewaysToShow({ gateways: [SIN], tunnels, groupDeviceIds: grp }), [])
    assert.deepEqual(gatewaysToShow({ gateways: [SIN], tunnels, groupDeviceIds: grp, showAll: true }), [])
  })

  test('a device without coordinates is never drawn, even with show-all', () => {
    const bare = dev(3, 'NO-COORDS', 0, 0)
    const nan = { id: 4, name: 'NAN', latitude: Number.NaN, longitude: Number.NaN }
    const tunnels = [tun(10, 100, 3), tun(11, 100, 4)]
    assert.deepEqual(gatewaysToShow({ gateways: [bare, nan], tunnels, groupDeviceIds: inGroup, showAll: true }), [])
  })

  test('a name matching two devices: only the one with tunnels shows, both under show-all', () => {
    const real = dev(280273, 'FlexVNF-004-Atlanta')
    const stale = dev(7118, 'FlexVNF-004-Atlanta')
    const tunnels = [tun(10, 100, 280273)]
    const auto = gatewaysToShow({ gateways: [stale, real], tunnels, groupDeviceIds: inGroup })
    assert.deepEqual(auto.map((d) => d.id), [280273])
    const all = gatewaysToShow({ gateways: [stale, real], tunnels, groupDeviceIds: inGroup, showAll: true })
    assert.deepEqual(all.map((d) => d.id), [7118, 280273])
  })

  test('only a tunnel that ENDS at the gateway links it (a tunnel starting there does not)', () => {
    const out = gatewaysToShow({ gateways: [SIN], tunnels: [tun(10, 1, 100)], groupDeviceIds: inGroup })
    assert.deepEqual(out, [])
  })

  test('input order is kept, inputs are not mutated', () => {
    const gws = [MTL, SIN]
    const tunnels = [tun(10, 100, 1), tun(11, 101, 2)]
    const before = JSON.stringify([gws, tunnels])
    const out = gatewaysToShow({ gateways: gws, tunnels, groupDeviceIds: inGroup })
    assert.deepEqual(out.map((d) => d.id), [2, 1])
    assert.equal(JSON.stringify([gws, tunnels]), before)
    assert.equal(MTL.gateway, undefined)
  })

  test('missing inputs mean nothing to show', () => {
    assert.deepEqual(gatewaysToShow({}), [])
    assert.deepEqual(gatewaysToShow({ gateways: null, tunnels: null, groupDeviceIds: null }), [])
    assert.deepEqual(gatewaysToShow({ gateways: [SIN], tunnels: null, groupDeviceIds: null }), [])
    assert.deepEqual(gatewaysToShow({ gateways: [SIN], tunnels: undefined, groupDeviceIds: inGroup, showAll: true }).map((d) => d.id), [1])
  })

  test('group ids may be given as an array', () => {
    const out = gatewaysToShow({ gateways: [SIN], tunnels: [tun(10, 100, 1)], groupDeviceIds: [100] })
    assert.deepEqual(out.map((d) => d.id), [1])
  })
})

describe('gatewayStatuses (why a configured gateway is or is not showing)', () => {
  const group = new Set([100])
  const tunnels = [tun(10, 100, 1), tun(11, 100, 1), tun(12, 100, 5)]
  const fetched = [
    dev(1, 'SIN-GW-01'),
    dev(2, 'QUIET-GW'),
    dev(3, 'NO-COORDS-GW', 0, 0),
    dev(4, 'MEMBER-GW'),
  ]
  const run = (refs, extra = {}) => gatewayStatuses(refs, extra.fetched ?? fetched, extra.tunnels ?? tunnels, extra.group ?? group)

  test('ok: found, has coordinates, group tunnels to it (with the tunnel count)', () => {
    const [s] = run({ ids: [], names: ['SIN-GW-01'] })
    assert.equal(s.status, 'ok')
    assert.equal(s.tunnels, 2)
    assert.deepEqual(s.deviceIds, [1])
    assert.equal(s.ref, 'SIN-GW-01')
  })

  test('notunnels: found and drawable, but the group has no tunnel to it', () => {
    const [s] = run({ ids: [2], names: [] })
    assert.equal(s.status, 'notunnels')
    assert.equal(s.tunnels, 0)
    assert.equal(s.ref, 2)
  })

  test('nocoordinates: found, but cannot be placed on the map', () => {
    assert.equal(run({ ids: [], names: ['NO-COORDS-GW'] })[0].status, 'nocoordinates')
  })

  test('notfound: nothing matches', () => {
    assert.equal(run({ ids: [999], names: ['GHOST'] })[0].status, 'notfound')
    assert.equal(run({ ids: [999], names: ['GHOST'] })[1].status, 'notfound')
  })

  test('ingroup: already a member of the dashboard group', () => {
    assert.equal(run({ ids: [4], names: [] }, { group: new Set([100, 4]) })[0].status, 'ingroup')
  })

  test('names match ignoring case', () => {
    assert.equal(run({ ids: [], names: ['sin-gw-01'] })[0].status, 'ok')
  })

  test('a name matching two devices is ok when either has tunnels, and counts both', () => {
    const two = [dev(7118, 'ATL'), dev(280273, 'ATL')]
    const t = [tun(1, 100, 280273), tun(2, 100, 280273), tun(3, 100, 7118)]
    const [s] = run({ ids: [], names: ['ATL'] }, { fetched: two, tunnels: t })
    assert.equal(s.status, 'ok')
    assert.equal(s.tunnels, 3)
    assert.deepEqual(s.deviceIds, [7118, 280273])
  })

  test('one entry per configured reference, ids first then names', () => {
    const out = run({ ids: [1, 999], names: ['QUIET-GW'] })
    assert.deepEqual(out.map((s) => [s.ref, s.status]), [[1, 'ok'], [999, 'notfound'], ['QUIET-GW', 'notunnels']])
  })

  test('nothing configured, nothing to report', () => {
    assert.deepEqual(gatewayStatuses({ ids: [], names: [] }, [], [], group), [])
    assert.deepEqual(gatewayStatuses(undefined, undefined, undefined, undefined), [])
  })
})
