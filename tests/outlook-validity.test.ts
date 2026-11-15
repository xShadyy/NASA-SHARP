import assert from 'node:assert/strict'
import test from 'node:test'
import { outlookExpired } from '../src/lib/outlook-validity.ts'

test('probabilities expire at the exclusive valid end, while historical reports have no forecast expiry', () => {
  const outlook = { state: 'experimental-forecast', validEnd: '2026-11-16T00:00:00Z' }
  assert.equal(outlookExpired(outlook, Date.parse('2026-11-15T23:59:59.999Z')), false)
  assert.equal(outlookExpired(outlook, Date.parse('2026-11-16T00:00:00Z')), true)
  assert.equal(outlookExpired({ state: 'experimental-forecast' }, 1), true)
  assert.equal(
    outlookExpired(
      { state: 'historical-activity', validEnd: outlook.validEnd },
      Date.parse('2026-11-17'),
    ),
    false,
  )
})
