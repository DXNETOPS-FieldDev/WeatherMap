// Unit tests for src/lib/threshold-alarms.js — run with `npm test`.
//
// In the "Thresholds" variant a device's color comes only from its threshold
// alarms (raised by Performance Management threshold profiles), and only from
// the severities ticked in the Network menu (default Critical + Major). The row
// shape is Performance Center OData `activealarms` as seen on dev-netops:
// ID, ItemID, Severity, AlarmType, ProfileName, StartTime, ClearTime, and an
// `interface` (Name, DeviceItemID) for interface alarms, whose own device link
// is null. Numeric severity codes are NOT mapped until real alarms show which
// number means what; an unmapped code never colors a marker.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  SEVERITIES, severityLabel, parseSelectedSeverities, normalizeThresholdAlarm,
  alarmsByDevice, worstSelectedSeverity, partitionBySeverity, alarmItemUrl,
} from '../src/lib/threshold-alarms.js'

const row = (over = {}) => ({
  ID: 1, ItemID: 7115, Severity: 'Major', AlarmType: 'Threshold', ProfileName: 'BW Utilization',
  StartTime: 1_800_000_000, ClearTime: 0, Description: 'A Threshold Violation event has been raised.', interface: null, ...over,
})
const ifaceRow = (over = {}) => row({ ItemID: 229773, interface: { Name: 'ge0/0', DeviceItemID: 1196734 }, ...over })
const alarm = (severity, startTime = 1, id = Math.random()) => ({ id, severity, startTime })

describe('severityLabel', () => {
  test('the three labels, any case', () => {
    assert.equal(severityLabel('Critical'), 'Critical')
    assert.equal(severityLabel('MAJOR'), 'Major')
    assert.equal(severityLabel(' minor '), 'Minor')
  })
  test('Performance Center codes 0, 1, 2 are Critical, Major, Minor', () => {
    // Measured on dev-netops 2026-11-04: rules named "> 30%", "> 10%", "> 3%" carried codes 0, 1, 2, and the
    // alarm console showed the same alarms as Critical, Major and Minor (74 rows, matched by rule).
    assert.equal(severityLabel(0), 'Critical')
    assert.equal(severityLabel(1), 'Major')
    assert.equal(severityLabel(2), 'Minor')
  })
  test('anything else is unknown (null), including codes not seen yet', () => {
    for (const v of ['Warning', '', null, undefined, 3, -1, 99, 1.5, '1', {}]) assert.equal(severityLabel(v), null, String(v))
  })
})

describe('parseSelectedSeverities (the default for the Network menu checkboxes)', () => {
  test('not configured: Critical and Major', () => {
    assert.deepEqual(parseSelectedSeverities(undefined), ['Critical', 'Major'])
    assert.deepEqual(parseSelectedSeverities(null), ['Critical', 'Major'])
    assert.deepEqual(parseSelectedSeverities('Critical'), ['Critical', 'Major'])
  })
  test('configured labels, any case, de-duplicated, in severity order', () => {
    assert.deepEqual(parseSelectedSeverities(['minor', 'Critical', 'MINOR']), ['Critical', 'Minor'])
  })
  test('junk entries are ignored', () => {
    assert.deepEqual(parseSelectedSeverities(['Major', 'Warning', 3]), ['Major'])
  })
  test('an explicit empty list means nothing ticked', () => {
    assert.deepEqual(parseSelectedSeverities([]), [])
  })
  test('the order constant runs worst first', () => {
    assert.deepEqual(SEVERITIES, ['Critical', 'Major', 'Minor'])
  })
})

describe('normalizeThresholdAlarm', () => {
  test('a device-level alarm belongs to its ItemID', () => {
    const a = normalizeThresholdAlarm(row())
    assert.equal(a.deviceId, 7115)
    assert.equal(a.interfaceName, null)
    assert.equal(a.severity, 'Major')
    assert.equal(a.profile, 'BW Utilization')
    assert.equal(a.startTime, 1_800_000_000)
    assert.equal(a.id, 1)
  })
  test('an interface alarm belongs to the interface\'s device, not to its own ItemID', () => {
    const a = normalizeThresholdAlarm(ifaceRow())
    assert.equal(a.deviceId, 1196734)
    assert.equal(a.interfaceName, 'ge0/0')
  })
  test('only threshold alarms, any case', () => {
    assert.equal(normalizeThresholdAlarm(row({ AlarmType: 'threshold' })).deviceId, 7115)
    assert.equal(normalizeThresholdAlarm(row({ AlarmType: 'Baseline' })), null)
    assert.equal(normalizeThresholdAlarm(row({ AlarmType: null })), null)
  })
  test('a cleared alarm is not active', () => {
    assert.equal(normalizeThresholdAlarm(row({ ClearTime: 1_800_000_500 })), null)
    assert.notEqual(normalizeThresholdAlarm(row({ ClearTime: null })), null)
    assert.notEqual(normalizeThresholdAlarm(row({ ClearTime: 0 })), null)
  })
  test('a code maps to its label; an unmapped one is kept as unknown, with the raw value', () => {
    assert.equal(normalizeThresholdAlarm(row({ Severity: 0 })).severity, 'Critical')
    const a = normalizeThresholdAlarm(row({ Severity: 9 }))
    assert.equal(a.severity, null)
    assert.equal(a.rawSeverity, 9)
  })
  test('the rule name comes from the Description; absent or unmatched: null', () => {
    const d = 'A Threshold Violation event has been raised. (Profile Name: BW Utilization, Rule Name: BW Utilization In > 30%)'
    assert.equal(normalizeThresholdAlarm(row({ Description: d })).ruleName, 'BW Utilization In > 30%')
    assert.equal(normalizeThresholdAlarm(row({ Description: 'something else' })).ruleName, null)
    assert.equal(normalizeThresholdAlarm(row({ Description: null })).ruleName, null)
  })
  test('the measured value is MetricValuesMax as a number (OData sends text); missing or junk: null, and 0 stays 0', () => {
    // Not DescriptionExtended: on dev-netops its "Max Polled Value" read 0.0 on every alarm whose value was 30-53.
    assert.equal(normalizeThresholdAlarm(row({ MetricValuesMax: '52.75' })).value, 52.75)
    assert.equal(normalizeThresholdAlarm(row({ MetricValuesMax: '0.0' })).value, 0)
    for (const v of [undefined, null, '', 'n/a']) assert.equal(normalizeThresholdAlarm(row({ MetricValuesMax: v })).value, null, String(v))
  })
  test('an interface alarm keeps the interface GlobalID (the id Portal pages use, not the OData ID)', () => {
    assert.equal(normalizeThresholdAlarm(ifaceRow({ interface: { Name: 'Et0/1', DeviceItemID: 227139, GlobalID: 55316 } })).interfaceGlobalId, 55316)
    assert.equal(normalizeThresholdAlarm(ifaceRow()).interfaceGlobalId, null)
    assert.equal(normalizeThresholdAlarm(row()).interfaceGlobalId, null)
    for (const junk of ['55316x', 0, -1, '']) {
      assert.equal(normalizeThresholdAlarm(ifaceRow({ interface: { Name: 'Et0/1', DeviceItemID: 227139, GlobalID: junk } })).interfaceGlobalId, null, String(junk))
    }
  })
  test('no device to attach it to: not usable', () => {
    assert.equal(normalizeThresholdAlarm(row({ ItemID: null })), null)
    assert.equal(normalizeThresholdAlarm(null), null)
    assert.equal(normalizeThresholdAlarm('x'), null)
  })
})

describe('alarmsByDevice', () => {
  test('groups the map\'s devices\' alarms, ignoring everyone else', () => {
    const m = alarmsByDevice([row({ ID: 1 }), ifaceRow({ ID: 2 }), row({ ID: 3, ItemID: 42 })], [7115, 1196734])
    assert.deepEqual([...m.keys()].sort((a, b) => a - b), [7115, 1196734])
    assert.equal(m.get(7115).length, 1)
    assert.equal(m.get(1196734)[0].interfaceName, 'ge0/0')
    assert.equal(m.has(42), false)
  })
  test('worst severity first, then newest first', () => {
    const m = alarmsByDevice([
      row({ ID: 1, Severity: 'Minor', StartTime: 300 }),
      row({ ID: 2, Severity: 'Critical', StartTime: 100 }),
      row({ ID: 3, Severity: 'Major', StartTime: 200 }),
      row({ ID: 4, Severity: 'Major', StartTime: 400 }),
      row({ ID: 5, Severity: 7, StartTime: 999 }),
    ], [7115])
    assert.deepEqual(m.get(7115).map((a) => a.id), [2, 4, 3, 1, 5])
  })
  test('non-threshold and cleared rows are dropped; nothing usable means no entry', () => {
    const m = alarmsByDevice([row({ AlarmType: 'Other' }), row({ ClearTime: 5 })], [7115])
    assert.equal(m.size, 0)
  })
  test('missing inputs: an empty map', () => {
    assert.equal(alarmsByDevice(null, [1]).size, 0)
    assert.equal(alarmsByDevice([row()], null).size, 0)
  })
})

describe('worstSelectedSeverity (the marker color)', () => {
  const list = [alarm('Minor'), alarm('Major')]
  test('the worst ticked severity', () => {
    assert.equal(worstSelectedSeverity(list, ['Critical', 'Major', 'Minor']), 'Major')
  })
  test('the worst wins wherever it sits in the list', () => {
    assert.equal(worstSelectedSeverity([alarm('Critical'), alarm('Minor')], ['Critical', 'Major', 'Minor']), 'Critical')
    assert.equal(worstSelectedSeverity([alarm('Minor'), alarm('Critical'), alarm('Major')], ['Critical', 'Major', 'Minor']), 'Critical')
  })
  test('an unticked severity does not count', () => {
    assert.equal(worstSelectedSeverity([alarm('Minor')], ['Critical', 'Major']), null)
    assert.equal(worstSelectedSeverity([alarm('Critical'), alarm('Minor')], ['Minor']), 'Minor')
  })
  test('unknown severities never color a marker', () => {
    assert.equal(worstSelectedSeverity([alarm(null)], ['Critical', 'Major', 'Minor']), null)
  })
  test('no alarms, nothing ticked, or bad input: null (green)', () => {
    assert.equal(worstSelectedSeverity([], ['Critical']), null)
    assert.equal(worstSelectedSeverity(list, []), null)
    assert.equal(worstSelectedSeverity(undefined, ['Critical']), null)
    assert.equal(worstSelectedSeverity(list, undefined), null)
  })
})

describe('partitionBySeverity (the Alarms tab)', () => {
  test('shows ticked severities and counts what is hidden, by severity', () => {
    const r = partitionBySeverity([alarm('Critical', 1, 'c'), alarm('Minor', 1, 'm1'), alarm('Minor', 1, 'm2'), alarm('Major', 1, 'M')], ['Critical', 'Major'])
    assert.deepEqual(r.shown.map((a) => a.id), ['c', 'M'])
    assert.deepEqual(r.hidden, { Minor: 2 })
  })
  test('nothing hidden: an empty object, not a zero count', () => {
    assert.deepEqual(partitionBySeverity([alarm('Major')], ['Major']).hidden, {})
  })
  test('unknown severities are always shown (they cannot be filtered by a label they lack)', () => {
    const r = partitionBySeverity([alarm(null, 1, 'u')], [])
    assert.deepEqual(r.shown.map((a) => a.id), ['u'])
    assert.deepEqual(r.hidden, {})
  })
  test('input order is kept', () => {
    const r = partitionBySeverity([alarm('Major', 1, 'a'), alarm('Critical', 1, 'b')], ['Critical', 'Major'])
    assert.deepEqual(r.shown.map((a) => a.id), ['a', 'b'])
  })
  test('bad input: nothing shown, nothing hidden', () => {
    assert.deepEqual(partitionBySeverity(null, ['Major']), { shown: [], hidden: {} })
  })
})

// Clicking an alarm opens the item it is on, through the Portal redirector, which
// picks the page type itself (verified on dev-netops: GlobalID 55316 opened
// Router atlanta-sw-acc-01 > Interface Et0/1). Same rule as BandwidthMap's
// portalItemUrl: GlobalID only, digits only, relative so one build fits any Portal.
describe('alarmItemUrl (where an alarm row links)', () => {
  const ifaceAlarm = (gid) => ({ interfaceName: 'Et0/1', interfaceGlobalId: gid })
  const deviceAlarm = { interfaceName: null, interfaceGlobalId: null }
  test('an interface alarm opens its interface', () => {
    assert.equal(alarmItemUrl(ifaceAlarm(55316), 54798), '/pc/redirector?ItemID=55316')
  })
  test('a device-level alarm opens its device', () => {
    assert.equal(alarmItemUrl(deviceAlarm, 54798), '/pc/redirector?ItemID=54798')
    assert.equal(alarmItemUrl(deviceAlarm, '54798'), '/pc/redirector?ItemID=54798')
  })
  test('an interface alarm without a GlobalID is not linked to the device instead', () => {
    assert.equal(alarmItemUrl(ifaceAlarm(null), 54798), null)
  })
  test('ids that are not plain positive whole numbers are never put in a URL', () => {
    for (const bad of ['55316&pg=x', '../admin', 'abc', '1 or 1', -5, 0, 1.5, null, undefined]) {
      assert.equal(alarmItemUrl(ifaceAlarm(bad), 54798), null, String(bad))
      assert.equal(alarmItemUrl(deviceAlarm, bad), null, String(bad))
    }
  })
  test('no alarm: null', () => {
    assert.equal(alarmItemUrl(null, 54798), null)
  })
})
