// Unit tests for src/lib/ncm-compliance.js — run with `npm test`.
//
// Fixture shapes mirror NCM 25.4's REST responses:
//   POST /network/{key|null}/devices/info  -> device records
//   POST /event                            -> auditRecords
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildNcmIndex,
  matchNcmDevice,
  normalizeComplianceStatus,
  parsePolicyList,
  latestComplianceEventByDevice,
  complianceDetails,
  ncmDeviceLink,
  ncmInfoForDevice,
  nonCompliantDevices,
} from '../src/lib/ncm-compliance.js'

const NET = '0a110483bfe3cc3fa4211b129a010000'

function ncmDevice(name, { ip, host = `${name}.mydomain.com`, compliance = 'NotAudited', key } = {}) {
  return {
    deviceName: name,
    hostName: host,
    mgmtIpAddress: ip,
    devicePolicyCompliance: compliance,
    resourceIdentityInfo: { resourceKey: key || `key-${name}`, resourceType: 'DEVICE', resourceName: name },
    network: { resourceKey: NET, resourceType: 'NETWORK', resourceName: 'MPLS-Network' },
  }
}

function event(deviceKey, actionType, eventTime, payload = '') {
  return {
    actionType,
    eventTime,
    payload,
    deviceId: deviceKey == null ? null : { resourceKey: deviceKey, resourceType: 'DEVICE' },
    networkId: { resourceKey: NET, resourceType: 'NETWORK' },
  }
}

// The three non-compliant routers as dev-ncm reports them. R1 is the
// interesting one: NCM manages it on 192.168.103.1 while PC reports a
// different interface (192.168.101.2) as its primary IP.
const R1 = ncmDevice('R1', { ip: '192.168.103.1', compliance: 'NonCompliant' })
const R2 = ncmDevice('R2', { ip: '192.168.102.2', compliance: 'NonCompliant' })
const R3 = ncmDevice('R3', { ip: '192.168.103.2', compliance: 'NonCompliant' })
const CE1 = ncmDevice('CE1', { ip: '192.168.100.6' })
const FLEET = [R1, R2, R3, CE1]

describe('matchNcmDevice', () => {
  const index = buildNcmIndex(FLEET)

  test('matches on NCM hostName even when the IPs disagree (R1)', () => {
    assert.equal(matchNcmDevice(index, { name: 'R1.mydomain.com', ip: '192.168.101.2' }), R1)
  })

  test('hostName match ignores case, surrounding whitespace and a trailing dot', () => {
    // Two devices share the short name "core", so only the full host name can
    // match — otherwise the short-name fallback would hide a broken full match.
    const east = ncmDevice('core', { host: 'core.east.example.com', ip: '10.0.1.1', key: 'east' })
    const west = ncmDevice('core', { host: 'core.west.example.com', ip: '10.0.1.2', key: 'west' })
    const idx = buildNcmIndex([east, west])
    assert.equal(matchNcmDevice(idx, { name: '  CORE.West.Example.COM.  ', ip: null }), west)
  })

  test('a name match wins over an IP that points at a different NCM device', () => {
    assert.equal(matchNcmDevice(index, { name: 'R1.mydomain.com', ip: R2.mgmtIpAddress }), R1)
  })

  test('falls back to the short name when one side stores a bare name', () => {
    assert.equal(matchNcmDevice(index, { name: 'R2', ip: null }), R2)
    assert.equal(matchNcmDevice(index, { name: 'R2.other-domain.net', ip: null }), R2)
  })

  test('an ambiguous short name matches nothing rather than guessing', () => {
    const a = ncmDevice('SW1', { host: 'SW1.east.example.com', ip: '10.0.0.1', key: 'a' })
    const b = ncmDevice('SW1', { host: 'SW1.west.example.com', ip: '10.0.0.2', key: 'b' })
    const idx = buildNcmIndex([a, b])
    assert.equal(matchNcmDevice(idx, { name: 'SW1', ip: null }), null)
    // ...but the full hostName still disambiguates.
    assert.equal(matchNcmDevice(idx, { name: 'SW1.west.example.com', ip: null }), b)
  })

  test('falls back to IP when no name matches', () => {
    assert.equal(matchNcmDevice(index, { name: 'atlanta-core-rtr', ip: '192.168.102.2' }), R2)
  })

  test('an IP shared by two NCM devices matches nothing rather than guessing', () => {
    const idx = buildNcmIndex([
      ncmDevice('A', { ip: '10.9.9.9', key: 'a' }),
      ncmDevice('B', { ip: '10.9.9.9', key: 'b' }),
    ])
    assert.equal(matchNcmDevice(idx, { name: 'unrelated', ip: '10.9.9.9' }), null)
  })

  test('a device NCM does not manage matches nothing', () => {
    assert.equal(matchNcmDevice(index, { name: 'branch-42.example.com', ip: '172.16.0.1' }), null)
  })

  test('a name that is an IP address is not split into a short name', () => {
    const idx = buildNcmIndex([ncmDevice('10', { host: '10.lab.example.com', ip: '10.5.5.5', key: 'x' })])
    assert.equal(matchNcmDevice(idx, { name: '10.1.1.1', ip: null }), null)
  })

  test('missing fields on either side do not throw', () => {
    const sparse = { deviceName: 'X', resourceIdentityInfo: { resourceKey: 'kx' } }
    const idx = buildNcmIndex([sparse, null, {}])
    assert.equal(matchNcmDevice(idx, { name: null, ip: undefined }), null)
    assert.equal(matchNcmDevice(idx, {}), null)
    assert.equal(matchNcmDevice(idx, { name: 'X' }), sparse)
  })
})

describe('normalizeComplianceStatus', () => {
  test('maps each value NCM 25.4 reports', () => {
    assert.equal(normalizeComplianceStatus('Compliant'), 'compliant')
    assert.equal(normalizeComplianceStatus('NonCompliant'), 'noncompliant')
    assert.equal(normalizeComplianceStatus('NotAudited'), 'notaudited')
    assert.equal(normalizeComplianceStatus('Error'), 'error')
    assert.equal(normalizeComplianceStatus('DidNotQualify'), 'didnotqualify')
  })

  test('tolerates other spellings of the same value (builds differ)', () => {
    for (const v of ['NON_COMPLIANT', 'Non Compliant', 'noncompliant', 'Non-Compliant']) {
      assert.equal(normalizeComplianceStatus(v), 'noncompliant', v)
    }
    assert.equal(normalizeComplianceStatus('NOT_AUDITED'), 'notaudited')
  })

  test('anything else is "unrecognized" — never mistaken for compliant', () => {
    for (const v of ['Pending', 'Compliant?', 'true', '', null, undefined, 42]) {
      assert.equal(normalizeComplianceStatus(v), 'unrecognized', String(v))
    }
  })
})

describe('parsePolicyList', () => {
  const K = '0a110483fd9fdf3f87e1c7799a010000'

  test('one policy, with NCM\'s "<key>#<name>" prefix stripped', () => {
    assert.deepEqual(parsePolicyList(`Failed Policies: ${K}#Banner`, 'Failed Policies:'), ['Banner'])
  })

  test('several policies, comma-separated with uneven spacing', () => {
    const p = `Failed Policies: ${K}#CIP-005 R1 Policy,  ${K}#CIP-007 R1 ,${K}#Banner`
    assert.deepEqual(parsePolicyList(p, 'Failed Policies:'), ['CIP-005 R1 Policy', 'CIP-007 R1', 'Banner'])
  })

  test('only the first "#" separates the key, so a name may contain "#"', () => {
    assert.deepEqual(parsePolicyList(`Failed Policies: ${K}#Rule #5`, 'Failed Policies:'), ['Rule #5'])
  })

  test('an entry with no key prefix is kept as-is', () => {
    assert.deepEqual(parsePolicyList('Failed Policies: Banner', 'Failed Policies:'), ['Banner'])
  })

  test('a "#" is only a key separator after an NCM key, not inside a bare name', () => {
    assert.deepEqual(parsePolicyList('Failed Policies: Rule #5', 'Failed Policies:'), ['Rule #5'])
  })

  test('reads the requested line from a multi-line payload', () => {
    const p = `Device audited\nSuccessful Policies: ${K}#NTP\nFailed Policies: ${K}#Banner`
    assert.deepEqual(parsePolicyList(p, 'Failed Policies:'), ['Banner'])
    assert.deepEqual(parsePolicyList(p, 'Successful Policies:'), ['NTP'])
  })

  test('repeated policies are listed once', () => {
    assert.deepEqual(parsePolicyList(`Failed Policies: ${K}#Banner, ${K}#Banner`, 'Failed Policies:'), ['Banner'])
  })

  test('missing label, empty list, or no payload gives an empty list', () => {
    assert.deepEqual(parsePolicyList('Successful Policies: x#NTP', 'Failed Policies:'), [])
    assert.deepEqual(parsePolicyList('Failed Policies:   ', 'Failed Policies:'), [])
    assert.deepEqual(parsePolicyList(null, 'Failed Policies:'), [])
    assert.deepEqual(parsePolicyList(undefined, 'Failed Policies:'), [])
  })
})

describe('latestComplianceEventByDevice', () => {
  test('keeps the newest compliance event per device, whatever the input order', () => {
    const old = event('k1', 'Device NonCompliant', 1000)
    const newer = event('k1', 'Device Compliant', 3000)
    const mid = event('k1', 'Device NonCompliant', 2000)
    const m = latestComplianceEventByDevice([old, newer, mid])
    assert.equal(m.get('k1'), newer)
  })

  test('a Device Compliant event supersedes an older NonCompliant one', () => {
    const m = latestComplianceEventByDevice([
      event('k1', 'Device Compliant', 5000),
      event('k1', 'Device NonCompliant', 4000),
    ])
    assert.equal(m.get('k1').actionType, 'Device Compliant')
  })

  test('ignores non-compliance events, even newer ones', () => {
    const nc = event('k1', 'Device NonCompliant', 1000)
    const m = latestComplianceEventByDevice([nc, event('k1', 'Device Configuration Change', 9000)])
    assert.equal(m.get('k1'), nc)
  })

  test('tolerates case and padding in actionType (NCM pads some values)', () => {
    const e = event('k1', ' device noncompliant ', 1000)
    assert.equal(latestComplianceEventByDevice([e]).get('k1'), e)
  })

  test('skips events with no device key', () => {
    const m = latestComplianceEventByDevice([event(null, 'Device NonCompliant', 1000)])
    assert.equal(m.size, 0)
  })

  test('empty or missing input gives an empty map', () => {
    assert.equal(latestComplianceEventByDevice([]).size, 0)
    assert.equal(latestComplianceEventByDevice(null).size, 0)
  })
})

describe('complianceDetails', () => {
  const K = '0a110483fd9fdf3f87e1c7799a010000' // a real-shaped NCM policy key
  const failedEvent = event(R1.resourceIdentityInfo.resourceKey, 'Device NonCompliant', 1791312000000,
    `Failed Policies: ${K}#CIP-005 R1 Policy, ${K}#CIP-007 R1`)

  test('non-compliant device with a matching event: failed policies and audit time', () => {
    const d = complianceDetails(R1, failedEvent)
    assert.equal(d.status, 'noncompliant')
    assert.deepEqual(d.failedPolicies, ['CIP-005 R1 Policy', 'CIP-007 R1'])
    assert.equal(d.auditTime.getTime(), 1791312000000)
  })

  test('status always comes from the device record, not the event', () => {
    // dev-ncm: nine devices are NotAudited today but their newest event is an
    // old NonCompliant one. Showing its failed policies would be stale.
    const d = complianceDetails(CE1, event(CE1.resourceIdentityInfo.resourceKey, 'Device NonCompliant', 1000,
      `Failed Policies: ${K}#Banner`))
    assert.equal(d.status, 'notaudited')
    assert.deepEqual(d.failedPolicies, [])
    assert.equal(d.auditTime, null)
  })

  test('non-compliant device whose newest event says Compliant: no stale detail', () => {
    const d = complianceDetails(R1, event(R1.resourceIdentityInfo.resourceKey, 'Device Compliant', 2000))
    assert.equal(d.status, 'noncompliant')
    assert.deepEqual(d.failedPolicies, [])
    assert.equal(d.auditTime, null)
  })

  test('compliant device with a Compliant event: audit time, no failures', () => {
    const ok = ncmDevice('OK', { compliance: 'Compliant' })
    const d = complianceDetails(ok, event(ok.resourceIdentityInfo.resourceKey, 'Device Compliant', 7000))
    assert.equal(d.status, 'compliant')
    assert.equal(d.auditTime.getTime(), 7000)
    assert.deepEqual(d.failedPolicies, [])
  })

  test('an event for a different device is never applied', () => {
    const d = complianceDetails(R2, failedEvent)
    assert.deepEqual(d.failedPolicies, [])
    assert.equal(d.auditTime, null)
  })

  test('non-compliant device with no event at all: status only', () => {
    const d = complianceDetails(R1, undefined)
    assert.equal(d.status, 'noncompliant')
    assert.deepEqual(d.failedPolicies, [])
    assert.equal(d.auditTime, null)
  })

  test('no NCM device means "notinncm"', () => {
    assert.equal(complianceDetails(null, undefined).status, 'notinncm')
  })
})

describe('ncmDeviceLink', () => {
  const DEV = R1.resourceIdentityInfo.resourceKey

  test('builds the NCM device audit-trails URL', () => {
    assert.equal(
      ncmDeviceLink('https://ncm.example.com', R1),
      `https://ncm.example.com/ncm-portal/networks/device-details/${NET}/${DEV}/audit-trails`,
    )
  })

  test('tolerates trailing slashes on the base URL', () => {
    assert.equal(
      ncmDeviceLink('https://ncm.example.com:8880//', R1),
      `https://ncm.example.com:8880/ncm-portal/networks/device-details/${NET}/${DEV}/audit-trails`,
    )
  })

  test('no base URL configured means no link', () => {
    for (const base of [null, undefined, '', '   ']) assert.equal(ncmDeviceLink(base, R1), null)
  })

  test('missing device or network key means no link', () => {
    assert.equal(ncmDeviceLink('https://ncm.example.com', null), null)
    assert.equal(ncmDeviceLink('https://ncm.example.com', { ...R1, network: null }), null)
    assert.equal(ncmDeviceLink('https://ncm.example.com', { ...R1, resourceIdentityInfo: {} }), null)
  })

  test('refuses anything but an http(s) base URL', () => {
    for (const base of ['javascript:alert(1)//', 'ftp://ncm.example.com', '//ncm.example.com', 'ncm.example.com']) {
      assert.equal(ncmDeviceLink(base, R1), null, base)
    }
  })

  test('encodes keys so they cannot alter the path', () => {
    const odd = { ...R1, resourceIdentityInfo: { resourceKey: '../x?y' } }
    assert.equal(
      ncmDeviceLink('https://ncm.example.com', odd),
      `https://ncm.example.com/ncm-portal/networks/device-details/${NET}/..%2Fx%3Fy/audit-trails`,
    )
  })
})

describe('ncmInfoForDevice', () => {
  const K = '0a110483fd9fdf3f87e1c7799a010000'
  const index = buildNcmIndex(FLEET)
  const latest = latestComplianceEventByDevice([
    event(R1.resourceIdentityInfo.resourceKey, 'Device NonCompliant', 1791312000000, `Failed Policies: ${K}#Banner`),
  ])
  const UI = 'https://ncm.example.com'

  test('a map device NCM manages: status, detail, link and NCM name', () => {
    const info = ncmInfoForDevice(index, latest, { name: 'R1.mydomain.com', ip: '192.168.101.2' }, UI)
    assert.equal(info.status, 'noncompliant')
    assert.deepEqual(info.failedPolicies, ['Banner'])
    assert.equal(info.auditTime.getTime(), 1791312000000)
    assert.equal(info.link, ncmDeviceLink(UI, R1))
    assert.equal(info.ncmName, 'R1')
  })

  test('a map device NCM does not manage: notinncm, no link', () => {
    const info = ncmInfoForDevice(index, latest, { name: 'branch-9.example.com', ip: '172.16.9.9' }, UI)
    assert.equal(info.status, 'notinncm')
    assert.equal(info.link, null)
    assert.equal(info.ncmName, null)
  })

  test('without events (their fetch failed) the status is still right', () => {
    const info = ncmInfoForDevice(index, null, { name: 'R2.mydomain.com', ip: '192.168.102.2' }, UI)
    assert.equal(info.status, 'noncompliant')
    assert.deepEqual(info.failedPolicies, [])
    assert.equal(info.link, ncmDeviceLink(UI, R2))
  })
})

describe('nonCompliantDevices (the Network-menu filter)', () => {
  const dev = (id, status) => ({ id, ncm: status === undefined ? undefined : { status } })

  test('keeps only devices NCM reports as non-compliant', () => {
    const list = [dev(1, 'noncompliant'), dev(2, 'compliant'), dev(3, 'noncompliant'), dev(4, 'notaudited')]
    assert.deepEqual(nonCompliantDevices(list).map((d) => d.id), [1, 3])
  })

  test('every other state is filtered out — errors and unknowns are not "non-compliant"', () => {
    const list = ['error', 'didnotqualify', 'unrecognized', 'notinncm', 'unavailable'].map((s, i) => dev(i, s))
    assert.deepEqual(nonCompliantDevices(list), [])
  })

  test('devices with no NCM data at all are filtered out, not crashed on', () => {
    assert.deepEqual(nonCompliantDevices([dev(1, undefined), null, {}]), [])
  })

  test('empty or missing input gives an empty list', () => {
    assert.deepEqual(nonCompliantDevices([]), [])
    assert.deepEqual(nonCompliantDevices(null), [])
  })
})
