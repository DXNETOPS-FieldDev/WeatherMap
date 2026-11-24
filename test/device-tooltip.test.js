// Unit tests for the device marker's hover tooltip text (src/lib/deviceTooltip.js) — run with `npm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deviceTooltipLines } from '../src/lib/deviceTooltip.js'

test('host name and IP address', () => {
  assert.deepEqual(deviceTooltipLines({ name: 'R2.example.com', ip: '192.0.2.2' }), ['R2.example.com', '192.0.2.2'])
})

test('no IP address: the name alone, no empty line', () => {
  assert.deepEqual(deviceTooltipLines({ name: 'isp-target-1', ip: '' }), ['isp-target-1'])
  assert.deepEqual(deviceTooltipLines({ name: 'isp-target-1', ip: null }), ['isp-target-1'])
})

test('no name: the IP stands in', () => {
  assert.deepEqual(deviceTooltipLines({ name: '', ip: '192.0.2.9' }), ['192.0.2.9'])
})

test('neither: a placeholder rather than an empty tooltip', () => {
  assert.deepEqual(deviceTooltipLines({}), ['Unnamed device'])
})

test('a non-compliant configuration is mentioned (it used to be the dot\'s own title)', () => {
  assert.deepEqual(deviceTooltipLines({ name: 'sw1', ip: '192.0.2.3', ncm: { status: 'noncompliant' } }),
    ['sw1', '192.0.2.3', 'Configuration non-compliant (NCM)'])
})

test('compliant or unknown NCM status adds nothing', () => {
  assert.deepEqual(deviceTooltipLines({ name: 'sw1', ip: '192.0.2.3', ncm: { status: 'compliant' } }), ['sw1', '192.0.2.3'])
  assert.deepEqual(deviceTooltipLines({ name: 'sw1', ip: '192.0.2.3', ncm: { status: 'unavailable' } }), ['sw1', '192.0.2.3'])
})

test('IP and name are trimmed', () => {
  assert.deepEqual(deviceTooltipLines({ name: '  sw1 ', ip: ' 192.0.2.3 ' }), ['sw1', '192.0.2.3'])
})
