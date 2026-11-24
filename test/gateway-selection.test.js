// Unit tests for choosing which gateways (and so which of their tunnels) a site's map shows
// (src/lib/gateways.js) — run with `npm test`. Client feedback 2026-11-24: "not finding a way to select
// a specific gateway". Shapes as WeatherMap holds them after normalizing devices and tunnels.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { gatewaysToShow, withoutGateways, selectTunnels, gatewayLegendRows } from '../src/lib/gateways.js'

const dev = (id, name, lat = 40, lng = -75) => ({ id, name, latitude: lat, longitude: lng })
const tun = (id, sourceId, destId) => ({ id, sourceId, destId })
// A site (100, 101) tunnelling to three gateways outside its group (1, 2, 3); 1 and 2 also tunnel to each other.
const GW = [dev(1, 'GW-AMS'), dev(2, 'GW-SIN'), dev(3, 'GW-SYD')]
const SITE = new Set([100, 101])
const TUNNELS = [tun(10, 100, 1), tun(11, 100, 2), tun(12, 101, 2), tun(13, 101, 3), tun(14, 100, 101), tun(15, 1, 2)]
const ids = (ts) => ts.map((t) => t.id).sort((a, b) => a - b)
const GW_IDS = new Set([1, 2, 3])

describe('gatewaysToShow with a selection', () => {
  test('all selected by default', () => {
    assert.deepEqual(gatewaysToShow({ gateways: GW, tunnels: TUNNELS, groupDeviceIds: SITE }).map((g) => g.id), [1, 2, 3])
  })
  test('a deselected gateway is not drawn', () => {
    const out = gatewaysToShow({ gateways: GW, tunnels: TUNNELS, groupDeviceIds: SITE, deselected: new Set([2]) })
    assert.deepEqual(out.map((g) => g.id), [1, 3])
  })
})

describe('withoutGateways (the group markers leave listed gateways to the gateway layer)', () => {
  test('member gateways are removed from the group devices, others kept, order kept', () => {
    const devices = [dev(100, 'site-a'), dev(1, 'GW-AMS'), dev(101, 'site-b')]
    assert.deepEqual(withoutGateways(devices, new Set([1])).map((d) => d.id), [100, 101])
  })
  test('no gateways: the same list back', () => {
    const devices = [dev(100, 'site-a')]
    assert.equal(withoutGateways(devices, new Set()), devices)
  })
})

describe('selectTunnels', () => {
  const base = { tunnels: TUNNELS, gatewayIds: GW_IDS }

  test('all selected: every site tunnel and site-to-gateway tunnel, but not gateway-to-gateway', () => {
    assert.deepEqual(ids(selectTunnels(base)), [10, 11, 12, 13, 14])
  })
  test('deselecting a gateway hides exactly the tunnels that end at it', () => {
    assert.deepEqual(ids(selectTunnels({ ...base, deselected: new Set([2]) })), [10, 13, 14])
  })
  test('"only" one gateway: its tunnels plus the site own tunnels, nothing to the others', () => {
    assert.deepEqual(ids(selectTunnels({ ...base, deselected: new Set([1, 3]) })), [11, 12, 14])
  })
  test('the site rows still work: a hidden site hides its tunnels to gateways too', () => {
    assert.deepEqual(ids(selectTunnels({ ...base, hiddenSiteIds: new Set([101]) })), [10, 11])
  })
  test('gateway-to-gateway tunnels show with "Show all gateways" when both ends are selected', () => {
    assert.deepEqual(ids(selectTunnels({ ...base, showGatewayMesh: true })), [10, 11, 12, 13, 14, 15])
    assert.deepEqual(ids(selectTunnels({ ...base, showGatewayMesh: true, deselected: new Set([1]) })), [11, 12, 13, 14])
  })
  test('the gateway end can be the source too (a member gateway tunnelling to a site)', () => {
    assert.deepEqual(ids(selectTunnels({ tunnels: [tun(20, 2, 100)], gatewayIds: GW_IDS, deselected: new Set([2]) })), [])
    assert.deepEqual(ids(selectTunnels({ tunnels: [tun(20, 2, 100)], gatewayIds: GW_IDS })), [20])
  })
  test('no gateways configured: behaves as before (both ends must be visible)', () => {
    assert.deepEqual(ids(selectTunnels({ tunnels: TUNNELS, gatewayIds: new Set(), hiddenSiteIds: new Set([2]) })), [10, 13, 14])
  })
  test('missing input: nothing', () => {
    assert.deepEqual(selectTunnels({}), [])
  })
})

describe('gatewayLegendRows (the Gateways section of the Sites legend)', () => {
  const statuses = [
    { ref: 'GW-AMS', status: 'ok', deviceIds: [1], tunnels: 1 },
    { ref: 'GW-SIN', status: 'ok', deviceIds: [2], tunnels: 2 },
    { ref: 'GW-SYD', status: 'ok', deviceIds: [3], tunnels: 1 },
    { ref: 'GW-SCL', status: 'nocoordinates', deviceIds: [9], tunnels: 0 },
  ]
  const rows = gatewayLegendRows({ statuses, gateways: GW, tunnels: TUNNELS, gatewayIds: GW_IDS, deselected: new Set([3]) })

  test('one row per drawable gateway, sorted by name, with its site-tunnel count and selection', () => {
    assert.deepEqual(rows.filter((r) => r.selectable).map((r) => [r.name, r.tunnels, r.selected]),
      [['GW-AMS', 1, true], ['GW-SIN', 2, true], ['GW-SYD', 1, false]])
  })
  test('gateway-to-gateway tunnels are not counted as site tunnels', () => {
    assert.equal(rows.find((r) => r.name === 'GW-AMS').tunnels, 1)
  })
  test('an undrawable gateway is listed, not selectable, with the reason', () => {
    const scl = rows.find((r) => r.name === 'GW-SCL')
    assert.equal(scl.selectable, false)
    assert.match(scl.reason, /no latitude\/longitude/)
  })
})
